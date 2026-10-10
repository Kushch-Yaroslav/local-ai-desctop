import { useSyncExternalStore } from 'react';
import { getLanguage, subscribeLanguage } from '../shared/locale';

export function useLocale() {
  return useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage);
}
