// A fixed Spanish -> English glossary of common technical verbs and nouns (spec §8.4), used only by the 'en-gloss'
// search: it lets a Spanish prompt reach skills that have no Spanish example requests yet. Dependency-free. Keys are
// accent-free lowercase; a key with spaces matches only as adjacent whole words of the query. Values are English words
// as they appear in skill text. Inflections are separate keys because nothing here stems.
export const GLOSSARY = {
  // deploy and release
  desplegar: 'deploy', despliegue: 'deploy', desplegando: 'deploy', despliego: 'deploy', desplegamos: 'deploy',
  publicar: 'publish', publicacion: 'publish', lanzar: 'release', lanzamiento: 'release',
  subir: 'upload', servidor: 'server', nube: 'cloud', produccion: 'production',
  // build, run, test
  compilar: 'build', compilacion: 'build', construir: 'build', empaquetar: 'bundle', ejecutar: 'run', correr: 'run',
  probar: 'test', prueba: 'test', pruebas: 'test', testear: 'test', cobertura: 'coverage', simular: 'mock',
  depurar: 'debug', depuracion: 'debug', errores: 'error', falla: 'failure', fallo: 'failure',
  arreglar: 'fix', corregir: 'fix', reparar: 'fix', rendimiento: 'performance', optimizar: 'optimize',
  // code quality
  revisar: 'review', revision: 'review', refactorizar: 'refactor', limpiar: 'clean', formatear: 'format',
  formato: 'format', analizar: 'analyze', analisis: 'analysis', escanear: 'scan', auditar: 'audit',
  auditoria: 'audit', seguridad: 'security', vulnerabilidad: 'vulnerability', linter: 'lint',
  // version control
  rama: 'branch', ramas: 'branch', confirmar: 'commit', fusionar: 'merge', fusion: 'merge', conflicto: 'conflict',
  conflictos: 'conflict', repositorio: 'repository', clonar: 'clone',
  etiqueta: 'tag', historial: 'history', cambios: 'changes', cambio: 'change', versionar: 'version',
  actualizar: 'update', actualizacion: 'update', 'solicitud de cambios': 'pull request', 'pull request': 'pull request',
  // data
  'base de datos': 'database', datos: 'data', migrar: 'migrate', migracion: 'migration', migraciones: 'migration',
  tabla: 'table', tablas: 'table', consulta: 'query', consultas: 'query', esquema: 'schema', indice: 'index',
  respaldo: 'backup', importar: 'import', exportar: 'export', almacenamiento: 'storage',
  // web and api
  autenticacion: 'authentication', autenticar: 'authentication', autorizacion: 'authorization', permisos: 'permissions',
  sesion: 'session', contrasena: 'password', usuario: 'user', usuarios: 'user',
  ruta: 'route', rutas: 'route', peticion: 'request', respuesta: 'response',
  pagina: 'page', paginas: 'page', sitio: 'site', formulario: 'form', componente: 'component', componentes: 'component',
  estilos: 'styles', diseno: 'design', interfaz: 'interface', movil: 'mobile', aplicacion: 'app',
  // project work
  crear: 'create', agregar: 'add', anadir: 'add', eliminar: 'delete', borrar: 'delete', quitar: 'remove',
  instalar: 'install', instalacion: 'install', configurar: 'configure', configuracion: 'configuration',
  inicializar: 'init', proyecto: 'project', proyectos: 'project', archivo: 'file', archivos: 'file',
  carpeta: 'folder', plantilla: 'template', generar: 'generate', automatizar: 'automate', automatizacion: 'automation',
  escribir: 'write', redactar: 'write', leer: 'read', buscar: 'search', encontrar: 'find', convertir: 'convert',
  traducir: 'translate', resumir: 'summarize', resumen: 'summary', explicar: 'explain', documentar: 'document',
  documentacion: 'documentation', documento: 'document', informe: 'report', reporte: 'report',
  // operations
  monitorear: 'monitor', monitoreo: 'monitor', registros: 'logs', bitacora: 'logs', alerta: 'alert', alertas: 'alert',
  tarea: 'task', tareas: 'task', contenedor: 'container', contenedores: 'container',
  entorno: 'environment', secretos: 'secrets', credenciales: 'credentials',
  dominio: 'domain', certificado: 'certificate', escalar: 'scale', reiniciar: 'restart',
  // front end, design and content
  animacion: 'animation', grafico: 'chart', graficos: 'chart',
  imagen: 'image', imagenes: 'image', correo: 'email', mensaje: 'message',
  notificacion: 'notification', notificaciones: 'notification', accesibilidad: 'accessibility',
  traduccion: 'translation', idioma: 'language', presentacion: 'presentation',
};

const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const SINGLE = new Map();
const PHRASES = [];
for (const [key, english] of Object.entries(GLOSSARY)) {
  const words = english.split(' ');
  if (key.includes(' ')) PHRASES.push([` ${key} `, words]);
  else SINGLE.set(key, words);
}

// The English terms for a Spanish query's terms, deduplicated, in query order (single words), then multi-word keys.
// Lookup folds case and accents; a multi-word key like "base de datos" is matched on the joined terms. Words with no
// entry add nothing.
export function glossaryTerms(terms) {
  const folded = terms.map(fold);
  const out = new Set();
  for (const t of folded) for (const w of SINGLE.get(t) ?? []) out.add(w);
  const joined = ` ${folded.join(' ')} `;
  for (const [phrase, words] of PHRASES) if (joined.includes(phrase)) for (const w of words) out.add(w);
  return [...out];
}
