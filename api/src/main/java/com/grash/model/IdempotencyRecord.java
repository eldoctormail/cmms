package com.grash.model;

import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.persistence.*;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.Date;

/**
 * Outcome of a write request sent with an {@code Idempotency-Key} header, kept so
 * that a retry of the same request (e.g. after the client lost the response)
 * gets the original response instead of applying the change twice.
 */
@Entity
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@Table(uniqueConstraints = @UniqueConstraint(name = "uk_idempotency_record_user_key",
        columnNames = {"user_id", "idempotency_key"}))
@Schema(hidden = true)
public class IdempotencyRecord {

    public enum Status {
        IN_PROGRESS,
        COMPLETED
    }

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "user_id", nullable = false)
    private Long userId;

    @Column(name = "idempotency_key", nullable = false)
    private String idempotencyKey;

    /**
     * SHA-256 of method, path, query and body: a key reused for a different
     * request is rejected instead of replaying an unrelated response.
     */
    @Column(nullable = false, length = 64)
    private String requestHash;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 32)
    private Status status;

    private Integer responseStatus;

    @Column(columnDefinition = "TEXT")
    private String responseBody;

    private String responseContentType;

    @Column(nullable = false)
    private Date createdAt;
}
