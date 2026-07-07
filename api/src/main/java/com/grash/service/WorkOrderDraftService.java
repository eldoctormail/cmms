package com.grash.service;

import com.grash.model.WorkOrderDraft;
import com.grash.model.Company;
import com.grash.model.User;
import com.grash.repository.WorkOrderDraftRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Optional;

@Service
@RequiredArgsConstructor
public class WorkOrderDraftService {
    private final WorkOrderDraftRepository repo;

    public WorkOrderDraft createOrUpdate(Long id, String payload, Company company, User user, String title) {
        WorkOrderDraft draft = (id != null) ? repo.findById(id).orElse(new WorkOrderDraft()) : new WorkOrderDraft();
        draft.setCompany(company);
        draft.setCreatedBy(user);
        draft.setPayload(payload);
        draft.setTitle(title);
        return repo.save(draft);
    }

    public List<WorkOrderDraft> findByCompany(Long companyId) {
        return repo.findByCompanyId(companyId);
    }

    public Optional<WorkOrderDraft> findById(Long id) {
        return repo.findById(id);
    }

    public void deleteById(Long id) {
        repo.deleteById(id);
    }
}
