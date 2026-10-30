(function (root, factory) {
  const model = factory();
  if (typeof module === 'object' && module.exports) module.exports = model;
  else root.DMQuickNoteTypes = model;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const types = Object.freeze([
    Object.freeze({ id: 'quick', label: '随手记', folder: '随手记', placeholder: '写下此刻的想法…' }),
    Object.freeze({ id: 'meeting', label: '会议要点', folder: '会议要点', placeholder: '记下讨论要点、决定和下一步…' }),
    Object.freeze({ id: 'idea', label: '临时想法', folder: '临时想法', placeholder: '先记住这个灵感…' }),
  ]);
  function get(id) { return types.find(type => type.id === id) || types[0]; }
  function forNote(note) { return get(note?.noteType); }
  function title(id, date = new Date()) {
    const day = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
    return `${get(id).label} ${day}`;
  }
  return { types, get, forNote, title };
});
