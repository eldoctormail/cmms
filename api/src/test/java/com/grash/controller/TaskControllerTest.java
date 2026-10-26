package com.grash.controller;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

import java.time.Instant;
import java.util.Date;

import static org.junit.jupiter.api.Assertions.*;

/** Conflict detection for task updates made offline (If-Unmodified-Since). */
class TaskControllerTest {

    private static final Instant SEEN = Instant.parse("2026-10-26T10:00:00Z");

    private static MockHttpServletRequest withHeader(String value) {
        MockHttpServletRequest request = new MockHttpServletRequest("PATCH", "/tasks/1");
        if (value != null) request.addHeader("If-Unmodified-Since", value);
        return request;
    }

    @Test
    void ifUnmodifiedSince_parsesHttpDate() {
        assertEquals(SEEN.toEpochMilli(),
                TaskController.ifUnmodifiedSince(withHeader("Mon, 26 Oct 2026 10:00:00 GMT")));
    }

    @Test
    void ifUnmodifiedSince_absentOrInvalid_isIgnored() {
        assertEquals(-1, TaskController.ifUnmodifiedSince(withHeader(null)));
        assertEquals(-1, TaskController.ifUnmodifiedSince(withHeader("yesterday")));
    }

    @Test
    void taskChangedAfterTheClientSawIt_isAConflict() {
        Date updatedAt = Date.from(SEEN.plusSeconds(5));
        assertTrue(TaskController.isModifiedSince(updatedAt, SEEN.toEpochMilli()));
    }

    @Test
    void taskUnchanged_isNotAConflict() {
        // Sub-second differences are lost in HTTP dates and must not conflict.
        Date updatedAt = Date.from(SEEN.plusMillis(450));
        assertFalse(TaskController.isModifiedSince(updatedAt, SEEN.toEpochMilli()));
        assertFalse(TaskController.isModifiedSince(Date.from(SEEN.minusSeconds(60)), SEEN.toEpochMilli()));
    }

    @Test
    void withoutPrecondition_neverConflicts() {
        assertFalse(TaskController.isModifiedSince(Date.from(SEEN), -1));
        assertFalse(TaskController.isModifiedSince(null, SEEN.toEpochMilli()));
    }
}
