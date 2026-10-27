(() => {
  function create({ api }) {
    const sign = document.getElementById('pet-reminder');
    const board = sign.querySelector('.pet-reminder-board'), pole = sign.querySelector('.pet-reminder-pole'), paw = sign.querySelector('.pet-reminder-paw');
    const title = document.getElementById('pet-reminder-title'), message = document.getElementById('pet-reminder-message');
    const icon = document.getElementById('pet-reminder-icon'), kind = document.getElementById('pet-reminder-kind');
    const done = document.getElementById('pet-reminder-done'), later = document.getElementById('pet-reminder-later'), error = document.getElementById('pet-reminder-error');
    let current = null, acting = false;
    async function act(action) {
      if (!current?.showSign || acting) return;
      const token = current.token;
      acting = true; done.disabled = true; later.disabled = true;
      try { await api.reminderAct(token, action); }
      catch { error.textContent = '操作未能保存，请重试。'; error.hidden = false; }
      finally {
        acting = false;
        if (current?.token === token) { done.disabled = false; later.disabled = false; }
      }
    }
    done.addEventListener('click', () => { void act('done'); });
    later.addEventListener('click', () => { void act('snooze'); });
    return {
      update(next, animal) {
        if (next?.token !== current?.token) {
          acting = false;
          if (next) {
            title.textContent = next.title; message.textContent = next.message;
            icon.textContent = next.icon; kind.textContent = next.test ? '测试提醒 · 不计入统计' : '宠物提醒';
            done.textContent = next.test ? '结束预览' : next.doneLabel;
            later.textContent = next.test ? '关闭预览' : `${next.laterLabel} · ${next.snoozeMinutes} 分钟`;
            paw.style.background = ({ 'engineer-fox': '#d5965b', 'baby-dragon': '#b9c8a9', otter: '#a47f6b', capybara: '#ad855e', cat: '#eee0ce', dog: '#dbbd96', 'fluffy-rabbit': '#f3e8d8', hamster: '#e6ccab', seal: '#f2efe8', liangzi: '#d8a489', 'realistic-cockroach': '#814825', 'realistic-mosquito': '#8b816b' })[animal] || '#ddc7a9';
          }
          done.disabled = false; later.disabled = false;
        }
        current = next;
        sign.hidden = !next?.showSign;
        if (error.textContent !== (next?.error || '')) error.textContent = next?.error || '';
        error.hidden = !error.textContent;
      },
      position(shape) {
        if (sign.hidden) return;
        const margin = 16, center = (shape.left + shape.right) / 2;
        const hand = { x: shape.left + (shape.right - shape.left) * .76, y: shape.top + (shape.bottom - shape.top) * .58 };
        // The sign and pole meet the visible paw, rather than the atlas cell edge.
        board.style.maxHeight = `${Math.max(100, shape.top - 28)}px`;
        const x = Math.max(margin, Math.min(center - board.offsetWidth / 2, window.innerWidth - margin - board.offsetWidth));
        const y = Math.max(margin, shape.top - 12 - board.offsetHeight);
        sign.style.left = `${x}px`; sign.style.top = `${y}px`;
        const poleX = Math.max(20, Math.min(board.offsetWidth - 20, hand.x - x));
        pole.style.left = `${poleX}px`; pole.style.top = `${board.offsetHeight - 8}px`;
        pole.style.height = `${Math.max(20, hand.y - y - board.offsetHeight + 12)}px`;
        paw.style.left = `${poleX - 7}px`; paw.style.top = `${hand.y - y - 5}px`;
      },
      escape() { if (current?.showSign) { void act('snooze'); return true; } return false; },
    };
  }
  window.DMPetReminderView = { create };
})();
