package com.grash.service;

import com.grash.model.IdempotencyRecord;
import com.grash.repository.IdempotencyRecordRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Date;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Bookkeeping for requests sent with an {@code Idempotency-Key} header.
 * <p>
 * The mobile app queues changes made without connectivity and retries them
 * until it gets a response. If a request reached the server but the response
 * was lost, the retry carries the same key and gets the stored response back
 * instead of creating a second comment, time entry, etc.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class IdempotencyService {

    /**
     * How long keys are remembered. The app may stay offline for days before
     * retrying, so this is deliberately longer than a typical HTTP retry window.
     */
    static final Duration RETENTION = Duration.ofDays(7);
    /** An in-progress record older than this belongs to a request that died. */
    static final Duration ABANDONED_AFTER = Duration.ofMinutes(5);
    private static final Duration CLEANUP_INTERVAL = Duration.ofHours(1);

    public enum OutcomeType {
        /** First time this key is seen: run the request, then call {@link #complete}. */
        PROCEED,
        /** The request already completed: send the stored response. */
        REPLAY,
        /** The same request is still being processed. */
        IN_PROGRESS,
        /** The key was already used for a different request. */
        MISMATCH
    }

    public record Outcome(OutcomeType type, IdempotencyRecord record) {
    }

    private final IdempotencyRecordRepository repository;
    private final AtomicLong lastCleanup = new AtomicLong(0);
    private Clock clock = Clock.systemUTC();

    void setClock(Clock clock) {
        this.clock = clock;
    }

    public Outcome begin(Long userId, String key, String requestHash) {
        cleanupIfDue();
        Optional<IdempotencyRecord> existing = repository.findByUserIdAndIdempotencyKey(userId, key);
        if (existing.isPresent()) {
            IdempotencyRecord record = existing.get();
            if (!record.getRequestHash().equals(requestHash)) {
                return new Outcome(OutcomeType.MISMATCH, record);
            }
            if (record.getStatus() == IdempotencyRecord.Status.COMPLETED) {
                return new Outcome(OutcomeType.REPLAY, record);
            }
            if (!isAbandoned(record)) {
                return new Outcome(OutcomeType.IN_PROGRESS, record);
            }
            repository.delete(record);
        }
        try {
            IdempotencyRecord record = repository.saveAndFlush(IdempotencyRecord.builder()
                    .userId(userId)
                    .idempotencyKey(key)
                    .requestHash(requestHash)
                    .status(IdempotencyRecord.Status.IN_PROGRESS)
                    .createdAt(Date.from(clock.instant()))
                    .build());
            return new Outcome(OutcomeType.PROCEED, record);
        } catch (DataIntegrityViolationException e) {
            // A concurrent request with the same key inserted it first.
            return new Outcome(OutcomeType.IN_PROGRESS, null);
        }
    }

    /**
     * Stores the response of a request that went through. Only successful
     * responses are kept: a rejected request changed nothing, so the client may
     * correct it and send it again with the same key.
     */
    public void complete(IdempotencyRecord record, int status, String body, String contentType) {
        if (status < 200 || status >= 300) {
            abandon(record);
            return;
        }
        record.setStatus(IdempotencyRecord.Status.COMPLETED);
        record.setResponseStatus(status);
        record.setResponseBody(body);
        record.setResponseContentType(contentType);
        repository.save(record);
    }

    /** Forgets a key whose request failed, so it can be retried. */
    public void abandon(IdempotencyRecord record) {
        repository.delete(record);
    }

    private boolean isAbandoned(IdempotencyRecord record) {
        Instant startedAt = record.getCreatedAt().toInstant();
        return startedAt.plus(ABANDONED_AFTER).isBefore(clock.instant());
    }

    private void cleanupIfDue() {
        long now = clock.millis();
        long last = lastCleanup.get();
        if (now - last < CLEANUP_INTERVAL.toMillis() || !lastCleanup.compareAndSet(last, now)) {
            return;
        }
        try {
            int deleted = repository.deleteCreatedBefore(Date.from(clock.instant().minus(RETENTION)));
            if (deleted > 0) log.debug("Deleted {} expired idempotency records", deleted);
        } catch (RuntimeException e) {
            log.warn("Could not delete expired idempotency records", e);
        }
    }
}
