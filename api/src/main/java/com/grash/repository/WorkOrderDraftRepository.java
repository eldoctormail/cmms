package com.grash.repository;

import com.grash.model.WorkOrderDraft;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface WorkOrderDraftRepository extends JpaRepository<WorkOrderDraft, Long> {
    List<WorkOrderDraft> findByCompanyId(Long companyId);
}
