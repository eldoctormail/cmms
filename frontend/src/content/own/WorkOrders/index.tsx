@@
-                const newWo: WorkOrder = await dispatch(
-                  addWorkOrder({ ...formattedValues, ...(draftId ? {} : {}) , })
-                );
+                // attach draftId to payload so slice will send it as query param
+                const payloadForSubmit = draftId ? { ...formattedValues, __draftId: draftId } : formattedValues;
+                const newWo: WorkOrder = await dispatch(addWorkOrder(payloadForSubmit));
