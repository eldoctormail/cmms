package com.grash.security;

import com.grash.model.IdempotencyRecord;
import com.grash.service.IdempotencyService;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.jetbrains.annotations.NotNull;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.util.ContentCachingResponseWrapper;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Set;

/**
 * Makes write requests carrying an {@code Idempotency-Key} header safe to retry:
 * the first successful response is stored per user and key, and a retry of the
 * same request gets that response back without running the request again.
 * <p>
 * Requests without the header are not affected. Must run after the
 * authentication filters, since keys are scoped to the authenticated user.
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class IdempotencyFilter extends OncePerRequestFilter {

    public static final String IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
    public static final String REPLAYED_HEADER = "Idempotent-Replayed";
    static final int MAX_KEY_LENGTH = 255;
    /** Larger responses are not stored; such requests just aren't deduplicated. */
    static final int MAX_STORED_BODY_BYTES = 1024 * 1024;
    private static final Set<String> METHODS = Set.of("POST", "PUT", "PATCH", "DELETE");

    private final IdempotencyService idempotencyService;

    @Override
    protected void doFilterInternal(@NotNull HttpServletRequest request,
                                    @NotNull HttpServletResponse response,
                                    @NotNull FilterChain filterChain) throws ServletException, IOException {
        String key = request.getHeader(IDEMPOTENCY_KEY_HEADER);
        Long userId = currentUserId();
        if (key == null || key.isBlank() || userId == null || !METHODS.contains(request.getMethod())
                || hasFormBody(request)) {
            filterChain.doFilter(request, response);
            return;
        }
        if (key.length() > MAX_KEY_LENGTH) {
            writeError(response, HttpStatus.BAD_REQUEST, "Idempotency-Key is too long");
            return;
        }

        CachedBodyRequest cachedRequest = new CachedBodyRequest(request);
        IdempotencyService.Outcome outcome =
                idempotencyService.begin(userId, key, requestHash(cachedRequest));

        switch (outcome.type()) {
            case MISMATCH -> writeError(response, HttpStatus.UNPROCESSABLE_ENTITY,
                    "Idempotency-Key was already used for a different request");
            case IN_PROGRESS -> {
                response.setHeader("Retry-After", "1");
                writeError(response, HttpStatus.CONFLICT,
                        "A request with this Idempotency-Key is still being processed");
            }
            case REPLAY -> replay(outcome.record(), response);
            case PROCEED -> proceed(outcome.record(), cachedRequest, response, filterChain);
        }
    }

    private void proceed(IdempotencyRecord record, CachedBodyRequest request, HttpServletResponse response,
                         FilterChain filterChain) throws ServletException, IOException {
        ContentCachingResponseWrapper cachingResponse = new ContentCachingResponseWrapper(response);
        try {
            try {
                filterChain.doFilter(request, cachingResponse);
            } catch (IOException | ServletException | RuntimeException e) {
                // The request failed: forget the key so the client can retry.
                abandonQuietly(record);
                throw e;
            }
            store(record, cachingResponse);
        } finally {
            cachingResponse.copyBodyToResponse();
        }
    }

    private void store(IdempotencyRecord record, ContentCachingResponseWrapper response) {
        try {
            byte[] body = response.getContentAsByteArray();
            if (body.length > MAX_STORED_BODY_BYTES) {
                idempotencyService.abandon(record);
                return;
            }
            String contentType = response.getContentType();
            idempotencyService.complete(record, response.getStatus(),
                    new String(body, charsetOf(contentType)), contentType);
        } catch (RuntimeException e) {
            // The request itself succeeded; failing to store its response only
            // means a retry won't be deduplicated.
            log.warn("Could not store response for idempotency key {}", record.getIdempotencyKey(), e);
            abandonQuietly(record);
        }
    }

    private void abandonQuietly(IdempotencyRecord record) {
        try {
            idempotencyService.abandon(record);
        } catch (RuntimeException e) {
            log.warn("Could not release idempotency key {}", record.getIdempotencyKey(), e);
        }
    }

    private void replay(IdempotencyRecord record, HttpServletResponse response) throws IOException {
        response.setStatus(record.getResponseStatus());
        response.setHeader(REPLAYED_HEADER, "true");
        String body = record.getResponseBody();
        if (record.getResponseContentType() != null) response.setContentType(record.getResponseContentType());
        if (body != null && !body.isEmpty()) {
            byte[] bytes = body.getBytes(charsetOf(record.getResponseContentType()));
            response.setContentLength(bytes.length);
            response.getOutputStream().write(bytes);
        }
    }

    private static void writeError(HttpServletResponse response, HttpStatus status, String message)
            throws IOException {
        response.setStatus(status.value());
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setCharacterEncoding(StandardCharsets.UTF_8.name());
        // Same shape as SuccessResponse; messages are constants, no escaping needed.
        response.getWriter().write("{\"success\":false,\"message\":\"" + message + "\"}");
    }

    private static Long currentUserId() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication != null && authentication.isAuthenticated()
                && authentication.getPrincipal() instanceof CustomUserDetail userDetail
                && userDetail.getUser() != null) {
            return userDetail.getUser().getId();
        }
        return null;
    }

    /**
     * Multipart and form bodies are parsed by the container from the raw stream,
     * which this filter would consume; uploads are not retried offline anyway.
     */
    private static boolean hasFormBody(HttpServletRequest request) {
        String contentType = request.getContentType();
        if (contentType == null) return false;
        String lower = contentType.toLowerCase();
        return lower.startsWith("multipart/") || lower.startsWith("application/x-www-form-urlencoded");
    }

    static String requestHash(CachedBodyRequest request) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            String query = request.getQueryString();
            String target = request.getMethod() + " " + request.getRequestURI()
                    + (query != null ? "?" + query : "") + "\n";
            digest.update(target.getBytes(StandardCharsets.UTF_8));
            digest.update(request.getBody());
            return HexFormat.of().formatHex(digest.digest());
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 not available", e);
        }
    }

    static Charset charsetOf(String contentType) {
        if (contentType != null) {
            try {
                Charset charset = MediaType.parseMediaType(contentType).getCharset();
                if (charset != null) return charset;
            } catch (RuntimeException ignored) {
                // Fall back to UTF-8, which is what the JSON converters write.
            }
        }
        return StandardCharsets.UTF_8;
    }

    /** Reads the body once so it can be hashed and still be read by the controller. */
    static class CachedBodyRequest extends HttpServletRequestWrapper {
        private final byte[] body;

        CachedBodyRequest(HttpServletRequest request) throws IOException {
            super(request);
            this.body = request.getInputStream().readAllBytes();
        }

        byte[] getBody() {
            return body;
        }

        @Override
        public ServletInputStream getInputStream() {
            ByteArrayInputStream input = new ByteArrayInputStream(body);
            return new ServletInputStream() {
                @Override
                public boolean isFinished() {
                    return input.available() == 0;
                }

                @Override
                public boolean isReady() {
                    return true;
                }

                @Override
                public void setReadListener(ReadListener readListener) {
                    throw new UnsupportedOperationException();
                }

                @Override
                public int read() {
                    return input.read();
                }

                @Override
                public int read(byte[] b, int off, int len) {
                    return input.read(b, off, len);
                }
            };
        }

        @Override
        public BufferedReader getReader() {
            String encoding = getCharacterEncoding();
            Charset charset = encoding != null ? Charset.forName(encoding) : StandardCharsets.UTF_8;
            return new BufferedReader(new InputStreamReader(getInputStream(), charset));
        }

        @Override
        public int getContentLength() {
            return body.length;
        }

        @Override
        public long getContentLengthLong() {
            return body.length;
        }
    }
}
