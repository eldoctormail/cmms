package com.grash.security;

import com.grash.model.IdempotencyRecord;
import com.grash.model.User;
import com.grash.service.IdempotencyService;
import com.grash.service.IdempotencyService.Outcome;
import com.grash.service.IdempotencyService.OutcomeType;
import jakarta.servlet.FilterChain;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;

import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class IdempotencyFilterTest {

    @Mock
    private IdempotencyService idempotencyService;

    @InjectMocks
    private IdempotencyFilter filter;

    private final IdempotencyRecord record = IdempotencyRecord.builder().id(1L).idempotencyKey("k-1").build();

    @BeforeEach
    void authenticate() {
        User user = new User();
        user.setId(42L);
        CustomUserDetail principal = CustomUserDetail.builder().user(user).build();
        SecurityContextHolder.getContext().setAuthentication(
                new UsernamePasswordAuthenticationToken(principal, null, List.of()));
    }

    @AfterEach
    void tearDown() {
        SecurityContextHolder.clearContext();
    }

    private static MockHttpServletRequest post(String body) {
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/comments");
        request.setContentType("application/json");
        request.setContent(body.getBytes(StandardCharsets.UTF_8));
        request.addHeader(IdempotencyFilter.IDEMPOTENCY_KEY_HEADER, "k-1");
        return request;
    }

    /** Chain that reads the body like a controller and answers with a JSON body. */
    private static FilterChain controller(int status, String responseBody) {
        return (req, res) -> {
            String body = new String(req.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            assertEquals("{\"content\":\"hola\"}", body);
            HttpServletResponse response = (HttpServletResponse) res;
            response.setStatus(status);
            response.setContentType("application/json");
            response.getOutputStream().write(responseBody.getBytes(StandardCharsets.UTF_8));
        };
    }

    @Test
    void withoutHeader_passesThrough() throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/comments");
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilterInternal(request, response, chain);

        verify(chain).doFilter(request, response);
        verifyNoInteractions(idempotencyService);
    }

    @Test
    void readOnlyRequest_passesThrough() throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/comments/1");
        request.addHeader(IdempotencyFilter.IDEMPOTENCY_KEY_HEADER, "k-1");
        FilterChain chain = mock(FilterChain.class);

        filter.doFilterInternal(request, new MockHttpServletResponse(), chain);

        verify(chain).doFilter(eq(request), any());
        verifyNoInteractions(idempotencyService);
    }

    @Test
    void unauthenticated_passesThrough() throws Exception {
        SecurityContextHolder.clearContext();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilterInternal(post("{}"), new MockHttpServletResponse(), chain);

        verify(chain).doFilter(any(), any());
        verifyNoInteractions(idempotencyService);
    }

    @Test
    void multipart_passesThrough() throws Exception {
        MockHttpServletRequest request = post("{}");
        request.setContentType("multipart/form-data; boundary=x");
        FilterChain chain = mock(FilterChain.class);

        filter.doFilterInternal(request, new MockHttpServletResponse(), chain);

        verify(chain).doFilter(eq(request), any());
        verifyNoInteractions(idempotencyService);
    }

    @Test
    void firstRequest_runsAndStoresResponse() throws Exception {
        when(idempotencyService.begin(eq(42L), eq("k-1"), anyString()))
                .thenReturn(new Outcome(OutcomeType.PROCEED, record));
        MockHttpServletResponse response = new MockHttpServletResponse();

        filter.doFilterInternal(post("{\"content\":\"hola\"}"), response,
                controller(200, "{\"id\":7,\"content\":\"canción\"}"));

        assertEquals(200, response.getStatus());
        assertEquals("{\"id\":7,\"content\":\"canción\"}", response.getContentAsString(StandardCharsets.UTF_8));
        verify(idempotencyService).complete(record, 200, "{\"id\":7,\"content\":\"canción\"}", "application/json");
        verify(idempotencyService, never()).abandon(any());
    }

    @Test
    void retry_replaysStoredResponseWithoutRunningTheRequest() throws Exception {
        IdempotencyRecord completed = IdempotencyRecord.builder()
                .status(IdempotencyRecord.Status.COMPLETED)
                .responseStatus(200)
                .responseBody("{\"id\":7,\"content\":\"canción\"}")
                .responseContentType("application/json")
                .build();
        when(idempotencyService.begin(eq(42L), eq("k-1"), anyString()))
                .thenReturn(new Outcome(OutcomeType.REPLAY, completed));
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilterInternal(post("{\"content\":\"hola\"}"), response, chain);

        verifyNoInteractions(chain);
        assertEquals(200, response.getStatus());
        assertEquals("true", response.getHeader(IdempotencyFilter.REPLAYED_HEADER));
        assertEquals("{\"id\":7,\"content\":\"canción\"}", response.getContentAsString(StandardCharsets.UTF_8));
    }

    @Test
    void sameKeyStillRunning_returnsConflictWithRetryAfter() throws Exception {
        when(idempotencyService.begin(anyLong(), anyString(), anyString()))
                .thenReturn(new Outcome(OutcomeType.IN_PROGRESS, null));
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilterInternal(post("{}"), response, chain);

        verifyNoInteractions(chain);
        assertEquals(409, response.getStatus());
        assertEquals("1", response.getHeader("Retry-After"));
    }

    @Test
    void keyReusedForDifferentRequest_isRejected() throws Exception {
        when(idempotencyService.begin(anyLong(), anyString(), anyString()))
                .thenReturn(new Outcome(OutcomeType.MISMATCH, record));
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilterInternal(post("{}"), response, chain);

        verifyNoInteractions(chain);
        assertEquals(422, response.getStatus());
    }

    @Test
    void tooLongKey_isRejected() throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/comments");
        request.addHeader(IdempotencyFilter.IDEMPOTENCY_KEY_HEADER, "x".repeat(256));
        MockHttpServletResponse response = new MockHttpServletResponse();

        filter.doFilterInternal(request, response, mock(FilterChain.class));

        assertEquals(400, response.getStatus());
        verifyNoInteractions(idempotencyService);
    }

    @Test
    void failingRequest_releasesKey() throws Exception {
        when(idempotencyService.begin(anyLong(), anyString(), anyString()))
                .thenReturn(new Outcome(OutcomeType.PROCEED, record));
        FilterChain chain = (req, res) -> {
            throw new IllegalStateException("boom");
        };

        assertThrows(IllegalStateException.class,
                () -> filter.doFilterInternal(post("{}"), new MockHttpServletResponse(), chain));

        verify(idempotencyService).abandon(record);
        verify(idempotencyService, never()).complete(any(), anyInt(), any(), any());
    }

    @Test
    void storingFailure_doesNotFailTheRequest() throws Exception {
        when(idempotencyService.begin(anyLong(), anyString(), anyString()))
                .thenReturn(new Outcome(OutcomeType.PROCEED, record));
        doThrow(new RuntimeException("db down"))
                .when(idempotencyService).complete(any(), anyInt(), any(), any());
        MockHttpServletResponse response = new MockHttpServletResponse();

        filter.doFilterInternal(post("{\"content\":\"hola\"}"), response, controller(200, "{}"));

        assertEquals(200, response.getStatus());
        assertEquals("{}", response.getContentAsString());
        verify(idempotencyService).abandon(record);
    }

    @Test
    void requestHash_dependsOnPathAndBody() throws Exception {
        String a = IdempotencyFilter.requestHash(new IdempotencyFilter.CachedBodyRequest(post("{\"a\":1}")));
        String sameAgain = IdempotencyFilter.requestHash(new IdempotencyFilter.CachedBodyRequest(post("{\"a\":1}")));
        String otherBody = IdempotencyFilter.requestHash(new IdempotencyFilter.CachedBodyRequest(post("{\"a\":2}")));
        MockHttpServletRequest otherPath = post("{\"a\":1}");
        otherPath.setRequestURI("/labors");
        String otherUri = IdempotencyFilter.requestHash(new IdempotencyFilter.CachedBodyRequest(otherPath));

        assertEquals(a, sameAgain);
        assertNotEquals(a, otherBody);
        assertNotEquals(a, otherUri);
    }

    @Test
    void cachedBodyRequest_canBeReadByTheController() throws Exception {
        HttpServletRequest request = new IdempotencyFilter.CachedBodyRequest(post("{\"content\":\"hola\"}"));

        assertEquals("{\"content\":\"hola\"}", request.getReader().readLine());
        assertEquals(18, request.getContentLength());
    }
}
