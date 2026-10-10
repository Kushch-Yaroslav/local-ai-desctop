import type { MenuItemConstructorOptions } from 'electron';
import { getLanguage, t, type Language } from '../../shared/locale';

export function applicationMenu(onLanguage: (language: Language) => void, onHelp: () => void, device: 'cpu' | 'gpu' = 'cpu', onDevice: (device: 'cpu' | 'gpu') => void = () => {}): MenuItemConstructorOptions[] {
  const item = (label: string, role: MenuItemConstructorOptions['role']): MenuItemConstructorOptions => ({ label: t(label), role });
  return [
    { label: t('Файл'), submenu: [item('Закрыть', 'close'), item('Выйти', 'quit')] },
    { label: t('Правка'), submenu: [item('Отменить', 'undo'), item('Повторить', 'redo'), { type: 'separator' }, item('Вырезать', 'cut'), item('Копировать', 'copy'), item('Вставить', 'paste'), item('Выделить всё', 'selectAll')] },
    { label: t('Вид'), submenu: [item('Перезагрузить', 'reload'), item('Инструменты разработчика', 'toggleDevTools'), item('Исходный масштаб', 'resetZoom'), item('Увеличить', 'zoomIn'), item('Уменьшить', 'zoomOut'), item('Полный экран', 'togglefullscreen')] },
    { label: t('Окно'), submenu: [item('Свернуть', 'minimize'), item('Закрыть', 'close')] },
    { label: t('Справка'), submenu: [{ label: t('О приложении'), click: onHelp }] },
    { label: t('Язык'), submenu: (['ru', 'en'] as const).map(language => ({ label: language === 'ru' ? 'Русский' : 'English', type: 'radio', checked: getLanguage() === language, click: () => onLanguage(language) })) },
    { label: t('Обработка изображений'), submenu: (['cpu', 'gpu'] as const).map(value => ({ label: t(value === 'cpu' ? 'Процессор (CPU)' : 'Видеокарта (GPU)'), type: 'radio', checked: device === value, click: () => onDevice(value) })) },
  ];
}
