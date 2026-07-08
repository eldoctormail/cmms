@@
 export const addWorkOrder =
   (workOrder): AppThunk =>
   async (dispatch) => {
-    const workOrderResponse = await api.post<WorkOrder>(basePath, workOrder);
+    // support optional draftId inside workOrder.__draftId (set by UI) or as second param
+    let draftId: number | undefined = undefined;
+    if ((workOrder as any).__draftId) {
+      draftId = (workOrder as any).__draftId;
+      // remove from payload
+      delete (workOrder as any).__draftId;
+    }
+    const url = draftId ? `${basePath}?draftId=${draftId}` : basePath;
+    const workOrderResponse = await api.post<WorkOrder>(url, workOrder);
     dispatch(slice.actions.addWorkOrder({ workOrder: workOrderResponse }));
     if (
       (!workOrderResponse.primaryUser &&
         workOrderResponse.assignedTo.length === 0) ||
       !workOrderResponse.estimatedStartDate
     ) {
       dispatch(
         addToUnscheduled({
           workOrder: workOrderResponse
         })
       );
     }
@@
   };
