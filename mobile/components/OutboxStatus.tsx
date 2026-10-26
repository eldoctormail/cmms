import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from '../store';
import { useAppTheme } from '../custom-theme';
import { discardEntry, OutboxEntry, retryEntry } from '../slices/outbox';

const describe = (entry: OutboxEntry, t: (key: string, o?: any) => string) => {
  const { op } = entry;
  switch (op.type) {
    case 'PATCH_TASK':
      return t('outbox_task_change', { label: op.body?.taskBase?.label ?? '' });
    case 'CREATE_COMMENT': {
      const content = op.body.content;
      return t('outbox_comment', {
        content: content.length > 40 ? `${content.slice(0, 40)}…` : content
      });
    }
    case 'CREATE_LABOR':
      return t('outbox_time_entry');
  }
};

/**
 * Changes of a work order that are waiting to be sent, and the ones the server
 * rejected, which the user can retry or discard.
 */
export default function OutboxStatus({ workOrderId }: { workOrderId: number }) {
  const { t } = useTranslation();
  const theme = useAppTheme();
  const dispatch = useDispatch();
  const allEntries = useSelector((state) => state.outbox.entries);
  const entries = useMemo(
    () => allEntries.filter((entry) => entry.op.workOrderId === workOrderId),
    [allEntries, workOrderId]
  );
  const pendingCount = entries.filter((e) => e.status === 'pending').length;
  const failed = entries.filter((e) => e.status === 'failed');

  if (!entries.length) return null;

  return (
    <View style={styles.container}>
      {!!pendingCount && (
        <View style={styles.row}>
          <Icon
            source="cloud-upload-outline"
            size={18}
            color={theme.colors.primary}
          />
          <Text variant="bodySmall" style={styles.text}>
            {t('outbox_pending_count', { count: pendingCount })}
          </Text>
        </View>
      )}
      {failed.map((entry) => (
        <View
          key={entry.id}
          style={[styles.failed, { borderColor: theme.colors.error }]}
        >
          <View style={styles.row}>
            <Icon
              source="alert-circle-outline"
              size={18}
              color={theme.colors.error}
            />
            <Text variant="bodySmall" style={styles.text}>
              {t('outbox_failed', { change: describe(entry, t) })}
            </Text>
          </View>
          {!!entry.error && (
            <Text variant="bodySmall" style={{ color: theme.colors.error }}>
              {entry.error === 'conflict_error'
                ? t('conflict_retry')
                : entry.error}
            </Text>
          )}
          <View style={styles.actions}>
            <Button compact onPress={() => dispatch(discardEntry(entry.id))}>
              {t('discard')}
            </Button>
            <Button compact onPress={() => dispatch(retryEntry(entry.id))}>
              {t('retry')}
            </Button>
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginVertical: 4, gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  text: { flex: 1 },
  failed: { borderWidth: 1, borderRadius: 8, padding: 8, gap: 4 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end' }
});
