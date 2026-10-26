import { useContext } from 'react';
import { StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { useOffline } from '../contexts/OfflineContext';
import { CompanySettingsContext } from '../contexts/CompanySettingsContext';
import { useAppTheme } from '../custom-theme';

/** Shown on screens that fall back to data saved for offline use. */
export default function OfflineBanner({ hint }: { hint?: string }) {
  const { t } = useTranslation();
  const theme = useAppTheme();
  const { isOffline, syncedAt } = useOffline();
  const { getFormattedDate } = useContext(CompanySettingsContext);

  if (!isOffline) return null;

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: theme.colors.errorContainer }
      ]}
      accessibilityRole="alert"
    >
      <Icon source="cloud-off-outline" size={20} color={theme.colors.error} />
      <View style={styles.texts}>
        <Text
          variant="bodySmall"
          style={{ color: theme.colors.onErrorContainer }}
        >
          {syncedAt
            ? t('offline_banner_synced', { date: getFormattedDate(syncedAt) })
            : t('offline_banner_never_synced')}
        </Text>
        {!!hint && (
          <Text
            variant="bodySmall"
            style={{ color: theme.colors.onErrorContainer, marginTop: 2 }}
          >
            {hint}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    marginVertical: 6
  },
  texts: { flex: 1 }
});
