// Copiar como config.js (lo genera scripts/publicar_web.py desde el .env). La clave publishable es pública por diseño:
// la seguridad la dan el login y las políticas RLS del esquema cropmon (anon no lee nada).
window.CROPNDVI_CONFIG = { supabaseUrl: 'https://TU-PROYECTO.supabase.co', supabaseAnonKey: 'sb_publishable_...' };
