// Server-rendered report summary (#div_ficha_resumen) with the structure
// observed on the pre-2026 FECAPA portal. All identities are fictitious.
// The second cell of a player row holds "P" for a goalkeeper (`goalkeeper: true`).
export function reportHtml({
  final = true,
  period = true,
  home = 'CP PROVA',
  away = 'CH FICTICI',
  players = [{ id: 900001, given: 'JÚLIA', surname: 'PROVA TEST', goals: 2, yellow: 1, blue: 2, red: 1 }],
} = {}) {
  const table = (name, rows) => `<table class="competiciones_tabla_basic"><thead><tr><td><div class="nombre_equipo_thickbox_stats">${name}</div></td></tr><tr>
    <th>Nº</th><th>P</th><th></th><th>5i</th><th colspan="2">Nom</th><th>G</th><th>As</th><th>PE</th><th>FD</th><th>F-&gt;</th><th>F&lt;-</th>
    <th><div class="game_view_incidencias_roja" style="background-color: #FFCC00;">-</div></th><th><div class="game_view_incidencias_azul">-</div></th><th><div class="game_view_incidencias_roja">-</div></th>
    </tr></thead><tbody>${rows.map((p, i) => `<tr><td>${i + 1}</td><td>${p.goalkeeper ? 'P' : ''}</td><td></td><td></td><td></td><td><div class="player_season_stats" id_player="${p.id}"><spam>CAT</spam>${p.surname}<span class="texto_gris_11">${p.given}</span></div></td><td>${p.goals ?? ''}</td><td></td><td></td><td></td><td></td><td></td><td>${p.yellow ?? ''}</td><td>${p.blue ?? ''}</td><td>${p.red ?? ''}</td></tr>`).join('')}
    <tr><td colspan="6"></td><td>2</td></tr>
    <tr><td colspan="3"></td><td>E1</td><td></td><td colspan="7">ENTRENADORA PROVA</td><td>3</td><td>3</td><td>3</td></tr>
    <tr><td colspan="3"></td><td>D</td><td></td><td colspan="7">DELEGAT PROVA</td><td>3</td><td>3</td><td>3</td></tr></tbody></table>`;
  const periodMarker = period ? `<div id="game_period" class="${final ? 'periodo_fin' : ''}"></div>` : '';
  return `<div class="nombre1">${home}</div><div class="nombre2">${away}</div>${periodMarker}<span id="home_score">2</span><span id="away_score">0</span><div id="div_ficha_resumen">${table(home, players)}${table(away, [{ id: 999999, given: 'RIVAL', surname: 'FICTICI', goals: 0, goalkeeper: true }])}</div>`;
}
