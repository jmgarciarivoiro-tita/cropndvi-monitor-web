/* CropNDVI Monitor v4 — web de solo lectura sobre Supabase (esquema cropmon, con login y RLS).
 * Los datos los escribe el worker de la PC: NDVI semanal por cultivo, superficie, predicción de cosecha, lluvias y avance MAGyP.
 */
(function () {
  'use strict';
  const CFG = window.CROPNDVI_CONFIG || {};
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n, d = 0) => (n == null || !isFinite(n) ? '—' : Number(n).toLocaleString('es-AR', { maximumFractionDigits: d, minimumFractionDigits: d }));
  const fdia = s => (s ? new Date(String(s).slice(0, 10) + 'T12:00:00').toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' }) : '—');
  const fdiaL = s => (s ? new Date(String(s).slice(0, 10) + 'T12:00:00').toLocaleDateString('es-AR') : '—');
  const fdt = s => (s ? new Date(s).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
  const diasEntre = (a, b) => Math.round((new Date(String(b).slice(0, 10)) - new Date(String(a).slice(0, 10))) / 864e5);

  // ---------- cultivos y escalas (paleta validada: categórica para cultivos, una sola tonalidad para magnitudes) ----------
  const CULTIVOS = [
    { id: 'trigo', nombre: 'Trigo', color: '#2a78d6', magyp: 'trigo' },
    { id: 'maiz_temprano', nombre: 'Maíz temprano', color: '#eb6834', magyp: 'maiz' },
    { id: 'maiz_tardio', nombre: 'Maíz tardío', color: '#1baf7a', magyp: 'maiz' },
    { id: 'soja_1ra', nombre: 'Soja 1ra', color: '#eda100', magyp: 'soja_1ra' },
    { id: 'soja_2da', nombre: 'Soja 2da', color: '#e87ba4', magyp: 'soja_2da' },
  ];
  const CUL = Object.fromEntries(CULTIVOS.map(c => [c.id, c]));
  const RAMPA = ['#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#0d366b'];     // ordinal (5 pasos, validada)
  const SEQ = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
  const SIN_DATO = '#c9ccc6';
  const ESTADOS = [
    { id: 'crecimiento', label: 'En crecimiento', de: ['emergencia', 'vegetativo'] },
    { id: 'llenado', label: 'Llenado de grano', de: ['llenado'] },
    { id: 'madurez', label: 'Madurez', de: ['madurez'] },
    { id: 'cosecha', label: 'En cosecha', de: ['cosecha'] },
    { id: 'cosechado', label: 'Cosechado', de: ['cosechado'] },
  ];
  const estadoDe = e => ESTADOS.findIndex(x => x.de.includes(e));
  const MODOS = {
    estado: { titulo: 'Estado del cultivo', valor: r => (!r ? null : r.estado ? estadoDe(r.estado) : r.fin_ciclo_pct == null ? null : r.fin_ciclo_pct >= 5 ? 2 : 0), color: v => (v == null || v < 0 ? SIN_DATO : RAMPA[v]),
      texto: (v, r) => (v == null || v < 0 ? 'sin estimación' : ESTADOS[v].label + (r && r.estado ? (r.cosechado_pct > 0 && r.cosechado_pct < 98 ? ` · ${fmt(r.cosechado_pct)} %` : '')
        : r && r.fin_ciclo_pct >= 5 ? ` · ${fmt(r.fin_ciclo_pct)} % maduro` : '')) },
    cosecha: { titulo: '% del área cosechada (estimado)', valor: r => (r ? r.cosechado_pct : null), rango: [0, 100], suf: ' %' },
    ndvi: { titulo: 'NDVI de la última semana', valor: r => (r ? r.ndvi_p50 : null), rango: [0.15, 0.9], dec: 2 },
    lluvia: { titulo: 'Lluvia de los últimos 15 días (mm)', valor: (r, c) => (c ? c.api_15_mm : null), rango: [0, 120], suf: ' mm', porLocalidad: true },
  };
  function colorSeq(v, [a, b]) {
    if (v == null || !isFinite(v)) return SIN_DATO;
    const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
    return SEQ[Math.min(SEQ.length - 1, Math.floor(t * SEQ.length))];
  }
  const colorModo = (modo, v) => (MODOS[modo].color ? MODOS[modo].color(v) : colorSeq(v, MODOS[modo].rango));
  const textoModo = (modo, v, r) => (MODOS[modo].texto ? MODOS[modo].texto(v, r) : (v == null ? 'sin dato' : fmt(v, MODOS[modo].dec || 0) + (MODOS[modo].suf || '')));

  if (!CFG.supabaseUrl || !CFG.supabaseAnonKey || !window.supabase) {
    document.body.innerHTML = '<p style="padding:20px;font-family:sans-serif">Falta config.js (supabaseUrl / supabaseAnonKey).</p>';
    return;
  }
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, { db: { schema: 'cropmon' } });

  // ---------- estado ----------
  let me = null, map = null, capa = null;
  const S = { camp: null, cultivo: 'trigo', modo: 'estado', prov: '', deleg: '', texto: '', orden: 'valor', sel: null };
  let campanias = [], locs = new Map(), mapa = new Map(), clima = new Map(), oficial = new Map(), runs = [];
  const charts = {}, marcadores = new Map(), cacheDet = new Map();

  let toastTimer = null;
  function toast(msg, kind) {
    const el = $('#toast'); el.textContent = msg; el.className = 'toast show ' + (kind || '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.className = 'toast'; }, Math.min(12000, 4500 + String(msg).length * 30));
  }
  async function todas(armar, paso = 1000) {
    const out = [];
    for (let desde = 0; ; desde += paso) {
      const { data, error } = await armar().range(desde, desde + paso - 1);
      if (error) throw error;
      out.push(...(data || []));
      if (!data || data.length < paso) return out;
    }
  }
  const campaniaActual = () => { const d = new Date(); const y = d.getMonth() >= 4 ? d.getFullYear() : d.getFullYear() - 1; return `${y}/${y + 1}`; };

  // ---------- carga ----------
  async function cargarBase() {
    const [c, l, cl, w] = await Promise.all([
      sb.from('campanias').select('campania,mnc_disponible').order('campania', { ascending: false }),
      todas(() => sb.from('v_localidades').select('dept_id,nombre,provincia,lat,lon,departamento,delegacion').order('dept_id')),
      todas(() => sb.from('v_clima_reciente').select('dept_id,fecha,precip_mm,api_7_mm,api_15_mm,days_since_rain,soil_water_pct,tmean_c')),
      sb.from('runs').select('tipo,inicio,fin,estado,detalle').order('inicio', { ascending: false }).limit(40),
    ]);
    if (c.error) throw c.error;
    const actual = campaniaActual();
    campanias = (c.data || []).map(x => x.campania).filter(x => x <= actual);
    locs = new Map(l.map(x => [x.dept_id, x]));
    clima = new Map(cl.map(x => [x.dept_id, x]));
    runs = w.data || [];
    if (!S.camp) S.camp = campanias.includes(actual) ? actual : campanias[0];
    $('#fCamp').innerHTML = campanias.map(x => `<option ${x === S.camp ? 'selected' : ''}>${esc(x)}</option>`).join('');
    const provs = [...new Set(l.map(x => x.provincia))].sort();
    $('#fProv').innerHTML = '<option value="">Todas</option>' + provs.map(p => `<option>${esc(p)}</option>`).join('');
    pintarDelegaciones();
    pintarWorker();
  }
  async function cargarCampania() {
    document.body.classList.add('cargando');
    try {
      const filas = await todas(() => sb.from('v_mapa').select('dept_id,cultivo,ha,fuente,confianza_mascara,semana,ndvi_p50,fin_ciclo_pct,fecha_corte,estado,cosechado_pct,fecha_50,fecha_50_desde,fecha_50_hasta,fecha_90,fecha_90_desde,fecha_90_hasta,confianza').eq('campania', S.camp));
      mapa = new Map();
      for (const r of filas) { if (!mapa.has(r.dept_id)) mapa.set(r.dept_id, {}); mapa.get(r.dept_id)[r.cultivo] = r; }
      await cargarOficial();
      cacheDet.clear();
    } finally { document.body.classList.remove('cargando'); }
    pintarCultivos(); render();
  }
  // avance oficial MAGyP: último valor de cada delegación para el cultivo de la campaña
  async function cargarOficial() {
    oficial = new Map();
    const mg = [...new Set(CULTIVOS.map(c => c.magyp))];
    const filas = await todas(() => sb.from('avance_oficial').select('cultivo,zona,fecha,sembrado_pct,cosechado_pct').eq('fuente', 'MAGyP').eq('campania', S.camp).in('cultivo', mg).order('fecha'));
    for (const r of filas) {
      const k = r.cultivo + '|' + r.zona;
      const o = oficial.get(k) || { serie: [] };
      o.serie.push(r);
      if (r.cosechado_pct != null) o.cosecha = r;
      if (r.sembrado_pct != null) o.siembra = r;
      oficial.set(k, o);
    }
  }

  // ---------- filtros ----------
  function pintarCultivos() {
    const presentes = new Set(); for (const v of mapa.values()) Object.keys(v).forEach(k => presentes.add(k));
    $('#fCultivo').innerHTML = CULTIVOS.map(c => `<button type="button" role="radio" aria-checked="${c.id === S.cultivo}" data-c="${c.id}" ${presentes.has(c.id) ? '' : 'title="Sin datos todavía en esta campaña"'}>
      <i style="background:${c.color}"></i>${esc(c.nombre)}${presentes.has(c.id) ? '' : ' <small class="muted">·</small>'}</button>`).join('');
  }
  function pintarDelegaciones() {
    const ds = [...new Set([...locs.values()].filter(l => !S.prov || l.provincia === S.prov).map(l => l.delegacion).filter(Boolean))].sort();
    if (S.deleg && !ds.includes(S.deleg)) S.deleg = '';
    $('#fDeleg').innerHTML = '<option value="">Todas</option>' + ds.map(d => `<option ${d === S.deleg ? 'selected' : ''}>${esc(d)}</option>`).join('');
  }
  const normTxt = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  function filtradas() {
    const t = normTxt(S.texto);
    return [...locs.values()].filter(l => (!S.prov || l.provincia === S.prov) && (!S.deleg || l.delegacion === S.deleg)
      && (!t || normTxt(l.nombre + ' ' + l.departamento + ' ' + l.delegacion).includes(t)));
  }
  const filaDe = (id, cultivo = S.cultivo) => (mapa.get(id) || {})[cultivo];
  const valorDe = (l, modo = S.modo) => MODOS[modo].valor(filaDe(l.dept_id), clima.get(l.dept_id));
  const conCultivo = l => !!filaDe(l.dept_id) || MODOS[S.modo].porLocalidad;

  // ---------- mapa ----------
  function initMap() {
    map = L.map('map', { preferCanvas: true, zoomControl: true }).setView([-32.6, -62.2], 6);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { maxZoom: 13, attribution: '© OpenStreetMap · © CARTO' }).addTo(map);
    capa = L.layerGroup().addTo(map);
  }
  function radio(l) {
    const r = filaDe(l.dept_id);
    if (!r || !r.ha) return 4;
    return Math.max(4, Math.min(13, 3 + Math.sqrt(r.ha) / 4));
  }
  function pintarMapa(lista) {
    capa.clearLayers(); marcadores.clear();
    const orden = lista.slice().sort((a, b) => radio(b) - radio(a));     // las chicas arriba: no quedan tapadas
    for (const l of orden) {
      const v = valorDe(l), tiene = conCultivo(l);
      const m = L.circleMarker([l.lat, l.lon], { radius: tiene ? radio(l) : 3, color: '#fcfcfb', weight: 2, fillColor: tiene ? colorModo(S.modo, v) : SIN_DATO,
        fillOpacity: tiene ? 0.92 : 0.5, opacity: 1 });
      m.bindTooltip(() => { const d = document.createElement('div'); d.className = 'loc-tip'; d.append(l.nombre);
        const s = document.createElement('small'); s.textContent = `${tiene ? textoModo(S.modo, v, filaDe(l.dept_id)) : 'sin ' + CUL[S.cultivo].nombre.toLowerCase()} · ${l.provincia}`; d.append(s); return d; }, { direction: 'top', sticky: true });
      m.on('click', () => seleccionar(l.dept_id, false));
      m.addTo(capa); marcadores.set(l.dept_id, m);
    }
    pintarLeyenda();
  }
  function pintarLeyenda() {
    const md = MODOS[S.modo];
    let h = `<b>${esc(md.titulo)}</b>`;
    if (S.modo === 'estado') h += ESTADOS.map((e, i) => `<div class="it"><i class="sw" style="background:${RAMPA[i]}"></i>${esc(e.label)}</div>`).join('');
    else h += `<div class="grad" style="background:linear-gradient(90deg,${SEQ.join(',')})"></div><div class="esc"><span>${fmt(md.rango[0], md.dec || 0)}</span><span>${fmt(md.rango[1], md.dec || 0)}${esc(md.suf || '')}</span></div>`;
    h += `<div class="it"><i class="sw" style="background:${SIN_DATO}"></i>Sin dato</div>`;
    const sinPred = S.modo === 'estado' && ![...mapa.values()].some(v => v[S.cultivo] && v[S.cultivo].estado);
    h += `<small>${sinPred ? 'Sin predicción todavía: estado según la madurez satelital. ' : ''}${md.porLocalidad ? 'Tamaño fijo.' : `Tamaño: hectáreas de ${esc(CUL[S.cultivo].nombre.toLowerCase())} en el círculo de 3 km.`}</small>`;
    $('#leyenda').innerHTML = h;
  }

  // ---------- resumen y lista ----------
  function indicadores(lista) {
    const fs = lista.map(l => filaDe(l.dept_id)).filter(Boolean);
    const ha = fs.reduce((s, r) => s + (r.ha || 0), 0);
    const pond = k => { let a = 0, w = 0; for (const r of fs) if (r[k] != null && r.ha) { a += r[k] * r.ha; w += r.ha; } return w ? a / w : null; };
    const f50 = fs.map(r => r.fecha_50).filter(Boolean).sort();
    const deleg = [...new Set(lista.map(l => l.delegacion).filter(Boolean))];
    const of = deleg.map(d => oficial.get(CUL[S.cultivo].magyp + '|' + d)).filter(o => o && o.cosecha);
    const ofp = of.length ? of.reduce((s, o) => s + o.cosecha.cosechado_pct, 0) / of.length : null;
    const ofFecha = of.length ? of.map(o => o.cosecha.fecha).sort().pop() : null;
    return { n: fs.length, ha, cos: pond('cosechado_pct'), mad: pond('fin_ciclo_pct'), ndvi: pond('ndvi_p50'), f50: f50.length ? f50[Math.floor(f50.length / 2)] : null, ofp, ofFecha, nDel: of.length };
  }
  function renderResumen(lista) {
    const k = indicadores(lista), c = CUL[S.cultivo];
    $('#kpiTitulo').textContent = `${c.nombre} · ${S.camp}`;
    $('#summary').innerHTML = [
      [fmt(k.n), 'localidades', ''], [fmt(k.ha), 'ha relevadas', 'círculos de 3 km'], [k.ndvi == null ? '—' : fmt(k.ndvi, 2), 'NDVI medio', 'última semana'],
      [k.mad == null ? '—' : fmt(k.mad) + ' %', 'maduro', 'satélite'], [k.cos == null ? '—' : fmt(k.cos) + ' %', 'cosechado', 'estimado'],
      [k.ofp == null ? '—' : fmt(k.ofp) + ' %', 'cosechado MAGyP', k.ofFecha ? `${k.nDel} deleg. al ${fdia(k.ofFecha)}` : 'sin informe'],
    ].map(([b, s, m]) => `<div class="kpi"><b>${b}</b><span>${s}</span>${m ? `<small>${esc(m)}</small>` : ''}</div>`).join('');
    $('#kpiNota').textContent = k.f50 ? `Fecha mediana estimada del 50 % cosechado: ${fdiaL(k.f50)}.` :
      (k.n ? 'Todavía no hay predicción de cosecha para este cultivo.' : `Sin ${c.nombre.toLowerCase()} detectado en el filtro actual${S.camp === campaniaActual() && S.cultivo !== 'trigo' ? ' (maíz y soja se publican desde el 1 de enero)' : ''}.`);
  }
  function renderLista(lista) {
    const md = MODOS[S.modo];
    const con = lista.filter(conCultivo);
    const ord = { nombre: (a, b) => a.nombre.localeCompare(b.nombre), ha: (a, b) => ((filaDe(b.dept_id) || {}).ha || 0) - ((filaDe(a.dept_id) || {}).ha || 0),
      valor: (a, b) => ((valorDe(b) ?? -1e9) - (valorDe(a) ?? -1e9)) || a.nombre.localeCompare(b.nombre) }[S.orden];
    con.sort(ord);
    $('#filtroInfo').textContent = `${con.length} de ${lista.length} localidades con ${CUL[S.cultivo].nombre.toLowerCase()}${md.porLocalidad ? ' (lluvia: todas)' : ''}`;
    const max = 400;
    $('#list').innerHTML = con.length ? con.slice(0, max).map(l => {
      const v = valorDe(l), r = filaDe(l.dept_id);
      return `<button type="button" class="row ${S.sel === l.dept_id ? 'sel' : ''}" data-id="${l.dept_id}"><i class="dot" style="background:${colorModo(S.modo, v)}"></i>
        <span class="rn">${esc(l.nombre)}<small>${esc(l.provincia)} · ${esc(l.delegacion || 'sin delegación')}</small></span>
        <span class="rv">${esc(textoModo(S.modo, v, r))}<small>${r && r.ha ? fmt(r.ha) + ' ha' : ''}</small></span></button>`;
    }).join('') + (con.length > max ? `<p class="cap">Se muestran ${max}; afiná el filtro para ver el resto.</p>` : '')
      : `<div class="vacio">No hay localidades con ${esc(CUL[S.cultivo].nombre.toLowerCase())} en este filtro.</div>`;
  }
  function render() {
    const lista = filtradas();
    renderResumen(lista); renderLista(lista); pintarMapa(lista);
    if (S.sel) renderDetalle();
  }

  // ---------- detalle de una localidad ----------
  async function datosDetalle(id) {
    const k = id + '|' + S.camp;
    if (cacheDet.has(k)) return cacheDet.get(k);
    const prev = (() => { const y = Number(S.camp.slice(0, 4)) - 1; return `${y}/${y + 1}`; })();
    const desde = new Date(Date.now() - 75 * 864e5).toISOString().slice(0, 10);
    const [n, np, ll] = await Promise.all([
      sb.from('ndvi_semanal').select('cultivo,semana,ndvi_p25,ndvi_p50,ndvi_p75,frac_valida,fin_ciclo_pct').eq('dept_id', id).eq('campania', S.camp).order('semana'),
      sb.from('ndvi_semanal').select('cultivo,semana,ndvi_p50,fin_ciclo_pct').eq('dept_id', id).eq('campania', prev).order('semana'),
      sb.schema('public').from('precipitaciones_diarias').select('fecha,precip_mm,soil_water_pct').eq('dept_id', id).gte('fecha', desde).order('fecha'),
    ]);
    if (n.error) throw n.error;
    const d = { ndvi: n.data || [], prev: np.data || [], prevCamp: prev, lluvia: ll.error ? [] : (ll.data || []) };
    cacheDet.set(k, d);
    return d;
  }
  function seleccionar(id, centrar) {
    S.sel = id;
    document.querySelectorAll('#list .row').forEach(r => r.classList.toggle('sel', Number(r.dataset.id) === id));
    const l = locs.get(id);
    if (centrar && l) map.setView([l.lat, l.lon], Math.max(map.getZoom(), 9));
    renderDetalle();
    if (window.matchMedia('(max-width:900px)').matches) $('#detail').scrollIntoView({ behavior: 'smooth' });
  }
  function textoPrediccion(r, c, l) {
    if (!r || !r.estado) return `<div class="vacio">Sin predicción todavía para ${esc(c.nombre.toLowerCase())} en esta localidad.</div>`;
    const banda = (f, a, b) => (f ? `<b>${fdiaL(f)}</b>${a && b && (a !== f || b !== f) ? ` <span class="muted">(entre ${fdia(a)} y ${fdia(b)})</span>` : ''}` : '—');
    const ya = f => f && f <= r.fecha_corte;
    return `<div class="nota-pred">Al ${fdiaL(r.fecha_corte)}: <b>${fmt(r.cosechado_pct)} % cosechado</b> (estimado), ${fmt(r.fin_ciclo_pct)} % del área ya maduró.<br>
      ${ya(r.fecha_50) ? 'El 50 % se alcanzó el ' + fdiaL(r.fecha_50) : '50 % cosechado: ' + banda(r.fecha_50, r.fecha_50_desde, r.fecha_50_hasta)}<br>
      ${ya(r.fecha_90) ? 'El 90 % se alcanzó el ' + fdiaL(r.fecha_90) : '90 % cosechado: ' + banda(r.fecha_90, r.fecha_90_desde, r.fecha_90_hasta)}<br>
      <span class="muted">Confianza ${fmt((r.confianza || 0) * 100)} %. La banda combina el clima de años anteriores y el error medido contra el MAGyP.</span></div>`;
  }
  async function renderDetalle() {
    const id = S.sel, l = locs.get(id), el = $('#detail');
    if (!l) { el.hidden = true; return; }
    el.hidden = false;
    const fs = mapa.get(id) || {}, c = CUL[S.cultivo], r = fs[S.cultivo], cl = clima.get(id);
    const of = oficial.get(c.magyp + '|' + l.delegacion);
    el.innerHTML = `<div class="d-head"><h2 class="d-name" style="margin:0">${esc(l.nombre)}</h2>
      <div class="d-sub">${esc(l.provincia)} · Depto. ${esc(l.departamento || '—')} · Delegación MAGyP ${esc(l.delegacion || '—')}</div>
      <div class="badges">${r ? `<span class="estado-chip"><i style="background:${colorModo('estado', MODOS.estado.valor(r))}"></i>${esc(MODOS.estado.texto(MODOS.estado.valor(r), r))}</span>` : ''}
      <button class="btn" type="button" id="bCerrarDet">Cerrar</button></div></div>
      <h3>Cultivos en el círculo de 3 km · ${esc(S.camp)}</h3>
      <div class="tabla-scroll"><table class="cult"><tr><th>Cultivo</th><th>Ha</th><th>NDVI</th><th>Maduro</th><th>Cosechado</th><th>50 % cosechado</th></tr>
      ${CULTIVOS.filter(x => fs[x.id]).map(x => { const f = fs[x.id]; return `<tr class="${x.id === S.cultivo ? 'sel' : ''}"><td><i class="ck" style="background:${x.color}"></i>${esc(x.nombre)}<small>${f.fuente === 'mnc' ? 'mapa INTA' : 'clasificador · ' + fmt((f.confianza_mascara || 0) * 100) + ' %'}</small></td>
        <td>${fmt(f.ha)}</td><td>${fmt(f.ndvi_p50, 2)}<small>${fdia(f.semana)}</small></td><td>${f.fin_ciclo_pct == null ? '—' : fmt(f.fin_ciclo_pct) + ' %'}</td>
        <td>${f.cosechado_pct == null ? '—' : fmt(f.cosechado_pct) + ' %'}</td><td>${f.fecha_50 ? fdia(f.fecha_50) : '—'}</td></tr>`; }).join('') || '<tr><td colspan="6" class="muted">Sin cultivos detectados todavía.</td></tr>'}
      </table></div>
      <h3>Predicción de cosecha · ${esc(c.nombre)}</h3>${textoPrediccion(r, c, l)}
      <h3>NDVI semanal · ${esc(c.nombre)}</h3><div class="chart-box"><canvas id="cNdvi" aria-label="NDVI semanal"></canvas></div>
      <p class="cap">NDVI mediano de los píxeles del cultivo (banda: percentil 25 a 75). Línea gris: campaña anterior, si hay datos.</p>
      <h3>Avance · ${esc(c.nombre)}</h3><div class="chart-box"><canvas id="cAvance" aria-label="Avance de madurez y cosecha"></canvas></div>
      <p class="cap">Madurez: % del área del cultivo que llegó a madurez según el satélite. Cosecha MAGyP: avance oficial de la delegación ${esc(l.delegacion || '')}${of && of.cosecha ? ' (último informe ' + fdia(of.cosecha.fecha) + ')' : ''}. Estimado: avance actual y fechas del 50 % y 90 %.</p>
      <details class="tabla-ver" id="tablaAvance"><summary>Ver los datos en tabla</summary></details>
      <h3>Lluvias</h3>
      <div class="kvs"><div><b>${fmt(cl && cl.api_7_mm)}</b><span>mm 7 días</span></div><div><b>${fmt(cl && cl.api_15_mm)}</b><span>mm 15 días</span></div>
      <div><b>${fmt(cl && cl.days_since_rain)}</b><span>días sin lluvia</span></div><div><b>${cl && cl.soil_water_pct != null ? fmt(cl.soil_water_pct) + ' %' : '—'}</b><span>agua en el suelo</span></div></div>
      <div class="chart-box s"><canvas id="cLluvia" aria-label="Lluvia diaria"></canvas></div>
      <p class="cap">Lluvia diaria de los últimos 75 días (NASA POWER) al ${fdiaL(cl && cl.fecha)}.</p>`;
    $('#bCerrarDet').addEventListener('click', () => { S.sel = null; el.hidden = true; document.querySelectorAll('#list .row.sel').forEach(x => x.classList.remove('sel')); });
    let d;
    try { d = await datosDetalle(id); } catch (e) { toast('No se pudieron leer las series: ' + (e.message || e), 'err'); return; }
    if (S.sel !== id) return;
    dibujarNdvi(d, c); dibujarAvance(d, c, r, of); dibujarLluvia(d); tablaAvance(d, c, of);
  }

  // ---------- gráficos (una escala por gráfico; tooltip con todas las series en la misma fecha) ----------
  Chart.defaults.font.family = 'Inter, system-ui, sans-serif'; Chart.defaults.font.size = 11; Chart.defaults.color = '#52514e';
  const ejeT = (min, max) => ({ type: 'linear', min, max, grid: { color: '#ecece8' }, ticks: { maxTicksLimit: 7, callback: v => fdia(new Date(v).toISOString()) } });
  const ts = s => new Date(String(s).slice(0, 10) + 'T12:00:00').getTime();
  function grafico(id, cfg, vacio) {
    if (charts[id]) charts[id].destroy();
    const cv = document.getElementById(id); if (!cv) return null;
    if (!cfg.data.datasets.some(d => d.data.length)) { cv.parentElement.outerHTML = `<div class="vacio">${esc(vacio || 'Sin datos para este gráfico todavía.')}</div>`; return null; }
    charts[id] = new Chart(cv, cfg); return charts[id];
  }
  const tooltipBase = { mode: 'index', intersect: false, callbacks: { title: it => (it[0] ? fdiaL(new Date(it[0].parsed.x).toISOString()) : '') } };
  function cfgNdvi(d, c, impresion) {
    const s = d.ndvi.filter(x => x.cultivo === c.id && x.ndvi_p50 != null);
    const ant = d.prev.filter(x => x.cultivo === c.id && x.ndvi_p50 != null).map(x => ({ x: ts(x.semana) + 365.25 * 864e5, y: x.ndvi_p50 }));
    return { type: 'line', data: { datasets: [
      { label: 'p75', data: s.map(x => ({ x: ts(x.semana), y: x.ndvi_p75 })), borderWidth: 0, pointRadius: 0, fill: '+1', backgroundColor: c.color + '26' },
      { label: 'p25', data: s.map(x => ({ x: ts(x.semana), y: x.ndvi_p25 })), borderWidth: 0, pointRadius: 0, fill: false },
      { label: `${c.nombre} ${S.camp}`, data: s.map(x => ({ x: ts(x.semana), y: x.ndvi_p50 })), borderColor: c.color, borderWidth: 2, pointRadius: 2, pointHoverRadius: 5, tension: 0.25 },
      ...(ant.length ? [{ label: `Campaña ${d.prevCamp}`, data: ant, borderColor: '#9a9a94', borderDash: [4, 3], borderWidth: 1.5, pointRadius: 0, tension: 0.25 }] : []),
    ] }, options: { animation: !impresion, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { filter: i => !['p25', 'p75'].includes(i.text), boxWidth: 14, boxHeight: 2 } },
        tooltip: Object.assign({}, tooltipBase, { filter: i => !['p25', 'p75'].includes(i.dataset.label), callbacks: Object.assign({}, tooltipBase.callbacks, { label: i => ` ${fmt(i.parsed.y, 2)}  ${i.dataset.label}` }) }) },
      scales: { x: ejeT(s.length ? ts(s[0].semana) : undefined, undefined), y: { min: 0, max: 1, grid: { color: '#ecece8' }, title: { display: true, text: 'NDVI' } } } } };
  }
  function seriesAvance(d, c, r, of) {
    const mad = d.ndvi.filter(x => x.cultivo === c.id && x.fin_ciclo_pct != null).map(x => ({ x: ts(x.semana) + 3 * 864e5, y: x.fin_ciclo_pct }));
    const ofi = of ? of.serie.filter(x => x.cosechado_pct != null).map(x => ({ x: ts(x.fecha), y: x.cosechado_pct })) : [];
    const fut = (f, y) => (f && f > r.fecha_corte && r.cosechado_pct < y ? [{ x: ts(f), y }] : []);
    const est = r && r.fecha_corte ? [{ x: ts(r.fecha_corte), y: r.cosechado_pct }, ...fut(r.fecha_50, 50), ...fut(r.fecha_90, 90)] : [];
    return { mad, ofi, est };
  }
  function cfgAvance(d, c, r, of, impresion) {
    const { mad, ofi, est } = seriesAvance(d, c, r, of);
    const xs = [...mad, ...ofi, ...est].map(p => p.x);
    return { type: 'line', data: { datasets: [
      { label: 'Madurez (satélite)', data: mad, borderColor: '#256abf', borderWidth: 2, pointRadius: 0, tension: 0.2 },
      { label: 'Cosecha MAGyP (delegación)', data: ofi, borderColor: '#52514e', borderWidth: 2, pointRadius: 3, pointStyle: 'rect', tension: 0 },
      { label: 'Cosecha estimada', data: est, borderColor: '#eb6834', borderDash: [5, 4], borderWidth: 2, pointRadius: 5, pointHoverRadius: 7, pointBackgroundColor: '#eb6834', tension: 0 },
    ] }, options: { animation: !impresion, maintainAspectRatio: false, interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: { legend: { labels: { boxWidth: 14, boxHeight: 2 } }, tooltip: Object.assign({}, tooltipBase, { mode: 'nearest', axis: 'x', callbacks: Object.assign({}, tooltipBase.callbacks, { label: i => ` ${fmt(i.parsed.y)} %  ${i.dataset.label}` }) }) },
      scales: { x: ejeT(xs.length ? Math.min(...xs) - 7 * 864e5 : undefined, xs.length ? Math.max(...xs) + 7 * 864e5 : undefined), y: { min: 0, max: 100, grid: { color: '#ecece8' }, title: { display: true, text: '% del área' } } } } };
  }
  function dibujarNdvi(d, c) { grafico('cNdvi', cfgNdvi(d, c), `Sin serie de NDVI de ${c.nombre.toLowerCase()} en esta localidad para ${S.camp}.`); }
  function dibujarAvance(d, c, r, of) { grafico('cAvance', cfgAvance(d, c, r, of), 'Sin datos de madurez ni de cosecha todavía.'); }
  function dibujarLluvia(d) {
    grafico('cLluvia', { type: 'bar', data: { datasets: [{ label: 'Lluvia diaria (mm)', data: d.lluvia.map(x => ({ x: ts(x.fecha), y: x.precip_mm })), backgroundColor: '#3987e5', borderRadius: 2, barPercentage: 1, categoryPercentage: 0.9 }] },
      options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: Object.assign({}, tooltipBase, { callbacks: Object.assign({}, tooltipBase.callbacks, { label: i => ` ${fmt(i.parsed.y, 1)} mm` }) }) },
        scales: { x: Object.assign(ejeT(), { offset: true }), y: { beginAtZero: true, grid: { color: '#ecece8' }, title: { display: true, text: 'mm' } } } } }, 'Sin datos de lluvia para esta localidad.');
  }
  function tablaAvance(d, c, of) {
    const { mad, ofi } = seriesAvance(d, c, null, of);
    const semanas = new Map();
    for (const p of mad) semanas.set(p.x - 3 * 864e5, { mad: p.y });
    const nd = d.ndvi.filter(x => x.cultivo === c.id);
    for (const x of nd) { const k = ts(x.semana); semanas.set(k, Object.assign(semanas.get(k) || {}, { ndvi: x.ndvi_p50 })); }
    for (const p of ofi) { const k = p.x - ((new Date(p.x).getDay() + 6) % 7) * 864e5; semanas.set(k, Object.assign(semanas.get(k) || {}, { ofi: p.y })); }
    const filas = [...semanas.entries()].sort((a, b) => a[0] - b[0]);
    const el = $('#tablaAvance');
    const t = document.createElement('table');
    t.innerHTML = '<tr><th>Semana</th><th>NDVI</th><th>Maduro %</th><th>MAGyP cosechado %</th></tr>';
    for (const [k, v] of filas) {
      const tr = document.createElement('tr');
      [fdiaL(new Date(k).toISOString()), fmt(v.ndvi, 2), fmt(v.mad), fmt(v.ofi)].forEach(x => { const td = document.createElement('td'); td.textContent = x; tr.append(td); });
      t.append(tr);
    }
    el.querySelectorAll('table').forEach(x => x.remove()); el.append(t);
  }

  // ---------- informe ----------
  let infLista = [];
  function descFiltro() {
    return [CUL[S.cultivo].nombre, S.camp, S.prov || 'todas las provincias', S.deleg ? 'delegación ' + S.deleg : '', S.texto ? `"${S.texto}"` : ''].filter(Boolean).join(' · ');
  }
  const infElegidos = () => { const ids = new Set([...document.querySelectorAll('#infLista input:checked')].map(i => Number(i.value))); return infLista.filter(l => ids.has(l.dept_id)); };
  function filaInforme(l) {
    const r = filaDe(l.dept_id) || {}, cl = clima.get(l.dept_id) || {}, of = oficial.get(CUL[S.cultivo].magyp + '|' + l.delegacion);
    return { l, r, cl, of: of && of.cosecha };
  }
  function pngDe(cfg) {
    const cv = document.createElement('canvas'); cv.width = 900; cv.height = 320;
    const ch = new Chart(cv, Object.assign(cfg, { options: Object.assign(cfg.options, { responsive: false, animation: false, devicePixelRatio: 1 }) }));
    const url = cv.toDataURL('image/png'); ch.destroy(); return url;
  }
  const CSS_INFORME = `body{font:12px Inter,system-ui,sans-serif;color:#1d2a22;margin:24px auto;max-width:1100px;padding:0 16px}h1{font-size:18px;margin:0 0 4px}h2{font-size:14px;margin:18px 0 6px}
.meta{color:#5f6f66;margin-bottom:10px}.bar{position:sticky;top:0;background:#fff;padding:8px 0;display:flex;gap:10px;align-items:center;border-bottom:1px solid #e3e7e1;margin-bottom:12px}
.bar button{font:600 13px Inter,system-ui;background:#1f5f3a;color:#fff;border:0;border-radius:8px;padding:8px 12px;cursor:pointer}.muted{color:#5f6f66}
.k{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin:10px 0}.k div{background:#f6f7f4;border-radius:8px;padding:8px;text-align:center;color:#5f6f66;font-size:11px}.k b{display:block;font-size:16px;color:#1d2a22}
table{width:100%;border-collapse:collapse;font-size:11px}th,td{padding:4px 5px;border-bottom:1px solid #e3e7e1;text-align:left;vertical-align:top}th{background:#f6f7f4;font-weight:600}.n{text-align:right;font-variant-numeric:tabular-nums}
.tw{overflow-x:auto}.loc{break-before:page;margin-top:24px;padding-top:12px;border-top:2px solid #1f5f3a}.loc img{width:100%;max-width:900px;border:1px solid #e3e7e1;border-radius:6px;margin:4px 0}
.nota{color:#5f6f66;font-size:10.5px;line-height:1.45;margin-top:12px}@media print{.bar{display:none}body{margin:0;max-width:none}@page{size:A4 landscape;margin:10mm}.loc{margin-top:0;border-top:0}}`;
  async function abrirInforme(lista, detalle) {
    if (!lista.length) return toast('Elegí al menos una localidad.', 'warn');
    const w = window.open('', '_blank');
    if (!w) return toast('El navegador bloqueó la ventana del informe: permití ventanas emergentes para este sitio.', 'warn');
    w.document.write('<p style="font:14px system-ui;padding:24px">Preparando el informe…</p>');
    const k = indicadores(lista), c = CUL[S.cultivo], filas = lista.map(filaInforme);
    const det = [];
    if (detalle) {
      for (const l of lista.slice(0, 60)) {
        try {
          const d = await datosDetalle(l.dept_id), r = filaDe(l.dept_id), of = oficial.get(c.magyp + '|' + l.delegacion);
          det.push({ l, r, n: pngDe(cfgNdvi(d, c, true)), a: pngDe(cfgAvance(d, c, r, of, true)) });
        } catch (e) { console.warn('informe', l.dept_id, e); }
      }
    }
    const banda = (f, a, b) => (f ? fdiaL(f) + (a && b && (a !== f || b !== f) ? ` (${fdia(a)}–${fdia(b)})` : '') : '—');
    const html = `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Informe CropNDVI · ${esc(c.nombre)} ${esc(S.camp)}</title><style>${CSS_INFORME}</style></head><body>
<div class="bar"><button onclick="window.print()">Imprimir / Guardar como PDF</button><span class="muted">${lista.length} localidad(es)</span></div>
<h1>CropNDVI Monitor · ${esc(c.nombre)} · campaña ${esc(S.camp)}</h1>
<div class="meta">Generado ${esc(new Date().toLocaleString('es-AR'))} · ${esc(me?.email || '')} · Filtro: ${esc(descFiltro())}</div>
<div class="k"><div><b>${fmt(k.n)}</b>localidades</div><div><b>${fmt(k.ha)}</b>ha relevadas</div><div><b>${fmt(k.ndvi, 2)}</b>NDVI medio</div><div><b>${k.mad == null ? '—' : fmt(k.mad) + ' %'}</b>maduro</div><div><b>${k.cos == null ? '—' : fmt(k.cos) + ' %'}</b>cosechado (estimado)</div><div><b>${k.ofp == null ? '—' : fmt(k.ofp) + ' %'}</b>cosechado MAGyP</div></div>
<h2>Detalle por localidad</h2><div class="tw"><table><tr><th>Localidad</th><th>Provincia</th><th>Delegación</th><th class="n">Ha</th><th>Estado</th><th class="n">NDVI</th><th class="n">Maduro</th><th class="n">Cosechado est.</th><th>50 % cosechado</th><th>90 % cosechado</th><th class="n">Confianza</th><th class="n">MAGyP deleg.</th><th class="n">Lluvia 15 d</th></tr>
${filas.map(({ l, r, cl, of }) => `<tr><td>${esc(l.nombre)}</td><td>${esc(l.provincia)}</td><td>${esc(l.delegacion || '—')}</td><td class="n">${fmt(r.ha)}</td><td>${esc(r.estado ? MODOS.estado.texto(MODOS.estado.valor(r), r) : '—')}</td>
<td class="n">${fmt(r.ndvi_p50, 2)}</td><td class="n">${r.fin_ciclo_pct == null ? '—' : fmt(r.fin_ciclo_pct) + ' %'}</td><td class="n">${r.cosechado_pct == null ? '—' : fmt(r.cosechado_pct) + ' %'}</td>
<td>${banda(r.fecha_50, r.fecha_50_desde, r.fecha_50_hasta)}</td><td>${banda(r.fecha_90, r.fecha_90_desde, r.fecha_90_hasta)}</td><td class="n">${r.confianza == null ? '—' : fmt(r.confianza * 100) + ' %'}</td>
<td class="n">${of ? fmt(of.cosechado_pct) + ' % al ' + fdia(of.fecha) : '—'}</td><td class="n">${fmt(cl.api_15_mm)} mm</td></tr>`).join('')}</table></div>
<p class="nota">Hectáreas: superficie del cultivo dentro de un círculo de 3 km alrededor de cada localidad (mapa INTA en campañas publicadas; clasificador satelital en la campaña en curso). NDVI: Sentinel-2, solo píxeles del cultivo. Cosechado estimado y fechas: modelo calibrado contra el avance oficial del MAGyP; la banda combina el clima de años anteriores y el error medido. MAGyP: último informe semanal de la delegación. Lluvia: NASA POWER.</p>
${det.map(x => `<div class="loc"><h2>${esc(x.l.nombre)} · ${esc(x.l.provincia)} · delegación ${esc(x.l.delegacion || '—')}</h2><img src="${x.n}" alt="NDVI"><img src="${x.a}" alt="Avance"></div>`).join('')}
</body></html>`;
    try { w.document.open(); w.document.write(html); w.document.close(); } catch (e) { toast('No se pudo mostrar el informe: ' + e.message, 'err'); }
  }
  function descargarCSV(lista) {
    if (!lista.length) return toast('Elegí al menos una localidad.', 'warn');
    const num = (v, d = 1) => (v == null || v === '' ? '' : Number(v).toFixed(d).replace('.', ','));
    const cel = v => { const t = String(v ?? ''); return /[;"\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
    const cab = ['Localidad', 'Provincia', 'Departamento', 'Delegacion MAGyP', 'Cultivo', 'Campania', 'Ha (circulo 3 km)', 'Fuente mascara', 'Estado', 'NDVI', 'Semana NDVI',
      'Maduro %', 'Cosechado estimado %', 'Fecha 50%', 'Fecha 50% desde', 'Fecha 50% hasta', 'Fecha 90%', 'Fecha 90% desde', 'Fecha 90% hasta', 'Confianza', 'MAGyP cosechado %', 'MAGyP fecha', 'Lluvia 7 d mm', 'Lluvia 15 d mm', 'Agua en suelo %'];
    const filas = lista.map(filaInforme).map(({ l, r, cl, of }) => [l.nombre, l.provincia, l.departamento || '', l.delegacion || '', CUL[S.cultivo].nombre, S.camp, num(r.ha, 0), r.fuente || '', r.estado || '',
      num(r.ndvi_p50, 3), r.semana || '', num(r.fin_ciclo_pct), num(r.cosechado_pct), r.fecha_50 || '', r.fecha_50_desde || '', r.fecha_50_hasta || '', r.fecha_90 || '', r.fecha_90_desde || '', r.fecha_90_hasta || '',
      num(r.confianza, 2), of ? num(of.cosechado_pct) : '', of ? of.fecha : '', num(cl.api_7_mm), num(cl.api_15_mm), num(cl.soil_water_pct, 0)]);
    const csv = '﻿' + [cab, ...filas].map(f => f.map(cel).join(';')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `cropndvi_${S.cultivo}_${S.camp.replace('/', '-')}_${new Date().toISOString().slice(0, 10)}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function actualizarCuentaInf() {
    const n = infElegidos().length;
    $('#infCuenta').textContent = `${n} de ${infLista.length} localidad(es) seleccionadas`;
    $('#bInfPdf').disabled = $('#bInfCsv').disabled = !n;
  }

  // ---------- worker ----------
  function pintarWorker() {
    const ult = {};
    for (const r of runs) if (!ult[r.tipo] && r.fin) ult[r.tipo] = r;
    const pill = $('#workerPill');
    const nd = ult.ndvi, cl = ult.clima;
    if (!nd && !cl) { pill.textContent = 'Sin corridas todavía'; pill.className = 'pill warn'; return; }
    const viejo = (r, h) => !r || (Date.now() - new Date(r.fin)) / 36e5 > h;
    pill.textContent = `NDVI ${nd ? fdia(nd.fin) : '—'} · lluvias ${cl ? fdia(cl.fin) : '—'}`;
    pill.className = 'pill ' + (viejo(nd, 24 * 9) || viejo(cl, 50) || [nd, cl].some(r => r && r.estado === 'error') ? 'warn' : 'on');
    pill.title = Object.values(ult).map(r => `${r.tipo}: ${r.estado} · ${fdt(r.fin)}`).join('\n');
  }

  // ---------- eventos ----------
  $('#fCamp').addEventListener('change', e => { S.camp = e.target.value; S.sel = null; $('#detail').hidden = true; cargarCampania().catch(err => toast(err.message || String(err), 'err')); });
  $('#fCultivo').addEventListener('click', e => { const b = e.target.closest('button[data-c]'); if (!b) return; S.cultivo = b.dataset.c; pintarCultivos(); render(); });
  $('#fModo').addEventListener('change', e => { S.modo = e.target.value; render(); });
  $('#fProv').addEventListener('change', e => { S.prov = e.target.value; pintarDelegaciones(); render(); });
  $('#fDeleg').addEventListener('change', e => { S.deleg = e.target.value; render(); });
  $('#filtro').addEventListener('input', e => { S.texto = e.target.value; render(); });
  $('#orden').addEventListener('change', e => { S.orden = e.target.value; renderLista(filtradas()); });
  $('#list').addEventListener('click', e => { const b = e.target.closest('.row'); if (b) seleccionar(Number(b.dataset.id), true); });
  $('#bRefrescar').addEventListener('click', async () => { try { await cargarBase(); await cargarCampania(); toast('Datos actualizados.'); } catch (e) { toast(e.message || String(e), 'err'); } });
  $('#bInforme').addEventListener('click', () => {
    infLista = filtradas().filter(l => filaDe(l.dept_id));
    if (!infLista.length) return toast(`No hay localidades con ${CUL[S.cultivo].nombre.toLowerCase()} en el filtro actual.`, 'warn');
    $('#infTitulo').textContent = `Exportar informe · ${CUL[S.cultivo].nombre} · ${infLista.length} localidad(es)`;
    $('#infFiltro').textContent = 'Filtro: ' + descFiltro();
    $('#infLista').innerHTML = infLista.map(l => `<label><input type="checkbox" value="${l.dept_id}" checked><i class="dot" style="background:${colorModo(S.modo, valorDe(l))}"></i><span>${esc(l.nombre)}</span><small>${fmt((filaDe(l.dept_id) || {}).ha)} ha</small></label>`).join('');
    actualizarCuentaInf(); $('#modalInf').hidden = false;
  });
  $('#infLista').addEventListener('change', actualizarCuentaInf);
  $('#infTodos').addEventListener('click', () => { document.querySelectorAll('#infLista input').forEach(i => { i.checked = true; }); actualizarCuentaInf(); });
  $('#infNinguno').addEventListener('click', () => { document.querySelectorAll('#infLista input').forEach(i => { i.checked = false; }); actualizarCuentaInf(); });
  $('#bInfPdf').addEventListener('click', () => { const sel = infElegidos(); $('#modalInf').hidden = true; abrirInforme(sel, $('#infDetalle').checked); });
  $('#bInfCsv').addEventListener('click', () => { descargarCSV(infElegidos()); $('#modalInf').hidden = true; });
  $('#bInfClose').addEventListener('click', () => { $('#modalInf').hidden = true; });
  $('#modalInf').addEventListener('click', e => { if (e.target.id === 'modalInf') $('#modalInf').hidden = true; });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#modalInf').hidden = true; });

  // ---------- panel ajustable ----------
  const ANCHO_DEF = 440;
  function anchoMax() { return Math.max(320, Math.min(1100, window.innerWidth - 320)); }
  function fijarAncho(px, guardar) {
    const w = Math.round(Math.min(anchoMax(), Math.max(320, px)));
    document.querySelector('main').style.setProperty('--aside-w', w + 'px');
    $('#resizer').setAttribute('aria-valuenow', w);
    if (guardar) { try { localStorage.setItem('cropndvi.anchoPanel', String(w)); } catch (e) { /* sin almacenamiento */ } }
    if (map) map.invalidateSize({ pan: false });
    Object.values(charts).forEach(c => c && c.resize());
  }
  (function initResizer() {
    const rz = $('#resizer'), main = document.querySelector('main');
    let guardado = NaN; try { guardado = Number(localStorage.getItem('cropndvi.anchoPanel')); } catch (e) { /* nada */ }
    rz.setAttribute('aria-valuemin', 320); rz.setAttribute('aria-valuemax', anchoMax());
    fijarAncho(guardado > 0 ? guardado : ANCHO_DEF, false);
    let raf = 0;
    rz.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault(); rz.setPointerCapture(e.pointerId); rz.classList.add('drag'); document.body.classList.add('resizing');
      const mover = ev => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => fijarAncho(main.getBoundingClientRect().right - ev.clientX, false)); };
      const soltar = () => {
        rz.removeEventListener('pointermove', mover); rz.removeEventListener('pointerup', soltar); rz.removeEventListener('pointercancel', soltar);
        rz.classList.remove('drag'); document.body.classList.remove('resizing'); fijarAncho($('#panel').getBoundingClientRect().width, true);
      };
      rz.addEventListener('pointermove', mover); rz.addEventListener('pointerup', soltar); rz.addEventListener('pointercancel', soltar);
    });
    rz.addEventListener('dblclick', () => fijarAncho(ANCHO_DEF, true));
    rz.addEventListener('keydown', e => {
      const w = $('#panel').getBoundingClientRect().width;
      if (e.key === 'ArrowLeft') { e.preventDefault(); fijarAncho(w + 30, true); } else if (e.key === 'ArrowRight') { e.preventDefault(); fijarAncho(w - 30, true); } else if (e.key === 'Home') { e.preventDefault(); fijarAncho(ANCHO_DEF, true); }
    });
    const navH = () => document.documentElement.style.setProperty('--nav-h', $('#filtros').getBoundingClientRect().height + 'px');
    window.addEventListener('resize', () => { navH(); const w = $('#panel').getBoundingClientRect().width; if (window.innerWidth > 900 && w > anchoMax()) fijarAncho(anchoMax(), false); });
    new ResizeObserver(navH).observe($('#filtros'));
  })();
  const esMovil = () => window.matchMedia('(max-width:900px)').matches;
  window.addEventListener('scroll', () => { $('#bVerMapa').hidden = !(esMovil() && window.scrollY > window.innerHeight * 0.45); }, { passive: true });
  $('#bVerMapa').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

  // ---------- sesión ----------
  let recarga = null;
  async function entrar(session) {
    me = session.user;
    $('#login').hidden = true; $('#app').hidden = false;
    if (!map) initMap(); else map.invalidateSize();
    try { await cargarBase(); await cargarCampania(); }
    catch (e) { toast('No se pudieron leer los datos: ' + (e.message || e), 'err'); }
    clearInterval(recarga);
    recarga = setInterval(() => { if (!document.hidden) cargarBase().then(cargarCampania).catch(() => {}); }, 30 * 60 * 1000);
  }
  function salir() { me = null; clearInterval(recarga); $('#app').hidden = true; $('#login').hidden = false; }
  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault(); $('#lErr').textContent = ''; $('#lBtn').disabled = true;
    const { data, error } = await sb.auth.signInWithPassword({ email: $('#lEmail').value.trim(), password: $('#lPass').value });
    $('#lBtn').disabled = false;
    if (error) { $('#lErr').textContent = error.message === 'Invalid login credentials' ? 'Email o contraseña incorrectos.' : error.message; return; }
    entrar(data.session);
  });
  $('#bLogout').addEventListener('click', async () => { await sb.auth.signOut(); salir(); });
  // primer ingreso (invitación) o recuperación: el enlace del email abre la web con una sesión temporal para definir la contraseña
  const vieneDeEnlace = /type=(invite|recovery)/.test(location.hash + location.search);
  function pedirClave(session) {
    $('#app').hidden = true; $('#login').hidden = false; $('#loginForm').hidden = true; $('#claveForm').hidden = false;
    $('#cEmail').textContent = session && session.user ? session.user.email : '';
  }
  $('#lOlvide').addEventListener('click', async () => {
    const email = $('#lEmail').value.trim();
    if (!email) { $('#lErr').textContent = 'Escribí tu email y volvé a tocar el enlace.'; return; }
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    $('#lErr').textContent = error ? error.message : 'Si el email tiene usuario, te llega un enlace para definir la contraseña.';
  });
  $('#claveForm').addEventListener('submit', async e => {
    e.preventDefault(); $('#cErr').textContent = '';
    if ($('#c1').value !== $('#c2').value) { $('#cErr').textContent = 'Las contraseñas no coinciden.'; return; }
    $('#cBtn').disabled = true;
    const { data, error } = await sb.auth.updateUser({ password: $('#c1').value });
    $('#cBtn').disabled = false;
    if (error) { $('#cErr').textContent = error.message; return; }
    history.replaceState(null, '', location.pathname);
    $('#claveForm').hidden = true; $('#loginForm').hidden = false;
    const s2 = (await sb.auth.getSession()).data.session;
    if (s2) entrar(s2); else toast('Contraseña guardada: ingresá con tu email.');
  });
  sb.auth.getSession().then(({ data }) => {
    if (data.session && vieneDeEnlace) pedirClave(data.session);
    else if (data.session) entrar(data.session); else $('#login').hidden = false;
  });
  sb.auth.onAuthStateChange((ev, session) => { if (ev === 'SIGNED_OUT') salir(); if (ev === 'PASSWORD_RECOVERY') pedirClave(session); });
})();
