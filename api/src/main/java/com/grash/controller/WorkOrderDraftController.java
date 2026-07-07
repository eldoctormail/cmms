package com.grash.controller;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.grash.model.WorkOrderDraft;
import com.grash.model.User;
import com.grash.service.UserService;
import com.grash.service.WorkOrderDraftService;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

import jakarta.servlet.http.HttpServletRequest;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/work-order-drafts")
@RequiredArgsConstructor
@Tag(name = "Work Order Drafts")
public class WorkOrderDraftController {

    private final WorkOrderDraftService draftService;
    private final UserService userService;
    private final ObjectMapper objectMapper;

    @PostMapping("")
    @PreAuthorize("hasRole('ROLE_CLIENT')")
    public WorkOrderDraft createOrUpdate(@RequestBody Map<String, Object> body, HttpServletRequest req) throws Exception {
        User user = userService.whoami(req);
        Long id = body.get("id") != null ? Long.valueOf(body.get("id").toString()) : null;
        String title = body.get("title") != null ? body.get("title").toString() : null;
        Object payloadObj = body.get("payload");
        String payload = (payloadObj instanceof String) ? (String) payloadObj : objectMapper.writeValueAsString(payloadObj);

        return draftService.createOrUpdate(id, payload, user.getCompany(), user, title);
    }

    @GetMapping("")
    @PreAuthorize("hasRole('ROLE_CLIENT')")
    public List<WorkOrderDraft> list(HttpServletRequest req) {
        User user = userService.whoami(req);
        return draftService.findByCompany(user.getCompany().getId());
    }

    @GetMapping("/{id}")
    @PreAuthorize("hasRole('ROLE_CLIENT')")
    public WorkOrderDraft get(@PathVariable Long id, HttpServletRequest req) {
        User user = userService.whoami(req);
        WorkOrderDraft draft = draftService.findById(id).orElseThrow(() -> new RuntimeException("Not found"));
        if (!draft.getCompany().getId().equals(user.getCompany().getId())) {
            throw new RuntimeException("Access denied");
        }
        return draft;
    }

    @DeleteMapping("/{id}")
    @PreAuthorize("hasRole('ROLE_CLIENT')")
    public void delete(@PathVariable Long id, HttpServletRequest req) {
        User user = userService.whoami(req);
        WorkOrderDraft draft = draftService.findById(id).orElseThrow(() -> new RuntimeException("Not found"));
        if (!draft.getCompany().getId().equals(user.getCompany().getId())) {
            throw new RuntimeException("Access denied");
        }
        draftService.deleteById(id);
    }
}
