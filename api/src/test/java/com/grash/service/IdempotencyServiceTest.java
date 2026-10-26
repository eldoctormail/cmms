package com.grash.service;

import com.grash.model.IdempotencyRecord;
import com.grash.repository.IdempotencyRecordRepository;
import com.grash.service.IdempotencyService.OutcomeType;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.dao.DataIntegrityViolationException;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Date;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class IdempotencyServiceTest {

    private static final Instant NOW = Instant.parse("2026-10-26T10:00:00Z");

    @Mock
    private IdempotencyRecordRepository repository;

    @InjectMocks
    private IdempotencyService service;

    @BeforeEach
    void setUp() {
        service.setClock(Clock.fixed(NOW, ZoneOffset.UTC));
    }

    private IdempotencyRecord existing(IdempotencyRecord.Status status, String hash, Instant createdAt) {
        return IdempotencyRecord.builder()
                .id(5L).userId(1L).idempotencyKey("k").requestHash(hash)
                .status(status).createdAt(Date.from(createdAt))
                .build();
    }

    @Test
    void newKey_isRegisteredInProgress() {
        when(repository.findByUserIdAndIdempotencyKey(1L, "k")).thenReturn(Optional.empty());
        when(repository.saveAndFlush(any())).thenAnswer(inv -> inv.getArgument(0));

        IdempotencyService.Outcome outcome = service.begin(1L, "k", "h");

        assertEquals(OutcomeType.PROCEED, outcome.type());
        assertEquals(IdempotencyRecord.Status.IN_PROGRESS, outcome.record().getStatus());
        assertEquals("h", outcome.record().getRequestHash());
        assertEquals(Date.from(NOW), outcome.record().getCreatedAt());
    }

    @Test
    void completedKey_isReplayed() {
        IdempotencyRecord record = existing(IdempotencyRecord.Status.COMPLETED, "h", NOW);
        when(repository.findByUserIdAndIdempotencyKey(1L, "k")).thenReturn(Optional.of(record));

        IdempotencyService.Outcome outcome = service.begin(1L, "k", "h");

        assertEquals(OutcomeType.REPLAY, outcome.type());
        assertSame(record, outcome.record());
        verify(repository, never()).saveAndFlush(any());
    }

    @Test
    void keyUsedForAnotherRequest_isAMismatch() {
        when(repository.findByUserIdAndIdempotencyKey(1L, "k"))
                .thenReturn(Optional.of(existing(IdempotencyRecord.Status.COMPLETED, "other", NOW)));

        assertEquals(OutcomeType.MISMATCH, service.begin(1L, "k", "h").type());
    }

    @Test
    void keyStillRunning_isInProgress() {
        when(repository.findByUserIdAndIdempotencyKey(1L, "k"))
                .thenReturn(Optional.of(existing(IdempotencyRecord.Status.IN_PROGRESS, "h",
                        NOW.minus(Duration.ofSeconds(30)))));

        assertEquals(OutcomeType.IN_PROGRESS, service.begin(1L, "k", "h").type());
        verify(repository, never()).delete(any());
    }

    @Test
    void abandonedInProgressKey_isTakenOver() {
        IdempotencyRecord stale = existing(IdempotencyRecord.Status.IN_PROGRESS, "h",
                NOW.minus(IdempotencyService.ABANDONED_AFTER).minusSeconds(1));
        when(repository.findByUserIdAndIdempotencyKey(1L, "k")).thenReturn(Optional.of(stale));
        when(repository.saveAndFlush(any())).thenAnswer(inv -> inv.getArgument(0));

        IdempotencyService.Outcome outcome = service.begin(1L, "k", "h");

        verify(repository).delete(stale);
        assertEquals(OutcomeType.PROCEED, outcome.type());
    }

    @Test
    void concurrentInsert_isInProgress() {
        when(repository.findByUserIdAndIdempotencyKey(1L, "k")).thenReturn(Optional.empty());
        when(repository.saveAndFlush(any())).thenThrow(new DataIntegrityViolationException("duplicate"));

        assertEquals(OutcomeType.IN_PROGRESS, service.begin(1L, "k", "h").type());
    }

    @Test
    void successfulResponse_isStored() {
        IdempotencyRecord record = existing(IdempotencyRecord.Status.IN_PROGRESS, "h", NOW);

        service.complete(record, 201, "{\"id\":1}", "application/json");

        ArgumentCaptor<IdempotencyRecord> saved = ArgumentCaptor.forClass(IdempotencyRecord.class);
        verify(repository).save(saved.capture());
        assertEquals(IdempotencyRecord.Status.COMPLETED, saved.getValue().getStatus());
        assertEquals(201, saved.getValue().getResponseStatus());
        assertEquals("{\"id\":1}", saved.getValue().getResponseBody());
        assertEquals("application/json", saved.getValue().getResponseContentType());
    }

    @Test
    void rejectedResponse_releasesTheKey() {
        IdempotencyRecord record = existing(IdempotencyRecord.Status.IN_PROGRESS, "h", NOW);

        service.complete(record, 409, "{}", "application/json");

        verify(repository).delete(record);
        verify(repository, never()).save(any());
    }

    @Test
    void expiredRecords_areCleanedUpAtMostOncePerInterval() {
        when(repository.findByUserIdAndIdempotencyKey(any(), any())).thenReturn(Optional.empty());
        when(repository.saveAndFlush(any())).thenAnswer(inv -> inv.getArgument(0));

        service.begin(1L, "a", "h");
        service.begin(1L, "b", "h");

        verify(repository, times(1)).deleteCreatedBefore(Date.from(NOW.minus(IdempotencyService.RETENTION)));
    }

    @Test
    void cleanupFailure_doesNotBreakTheRequest() {
        when(repository.deleteCreatedBefore(any())).thenThrow(new RuntimeException("db"));
        when(repository.findByUserIdAndIdempotencyKey(1L, "k")).thenReturn(Optional.empty());
        when(repository.saveAndFlush(any())).thenAnswer(inv -> inv.getArgument(0));

        assertEquals(OutcomeType.PROCEED, service.begin(1L, "k", "h").type());
    }
}
