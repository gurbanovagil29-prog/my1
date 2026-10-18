// Настройки облачной синхронизации (Supabase). Пока поля пустые, календарь хранит данные только на устройстве.
// Сюда вписываются «Project URL» и публичный ключ «anon» / «publishable» из Supabase → Project Settings → API.
// Эти значения не секретные: доступ к данным защищён входом и правилами базы (supabase/schema.sql).
// Секретный ключ (service_role / secret) сюда вписывать нельзя.
window.SYNC_CONFIG = {
  supabaseUrl: 'https://dtwdhhyqseokmaliwkje.supabase.co',
  supabaseKey: 'sb_publishable_AGIJCUp1NL8l8o_RdSrBDg_xjniP1Jn',
  // true — показать кнопку «Войти через Google» (нужно включить Google в Supabase → Authentication → Providers)
  google: false,
};
