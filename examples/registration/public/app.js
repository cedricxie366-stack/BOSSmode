'use strict';

const form = document.querySelector('#registration-form');
const submitButton = document.querySelector('#submit-button');
const formStatus = document.querySelector('#form-status');
const remainingSeats = document.querySelector('#remaining-seats');
const capacity = document.querySelector('#capacity');
const confirmedCount = document.querySelector('#confirmed-count');
const waitlistCount = document.querySelector('#waitlist-count');
const formGuidance = document.querySelector('#form-guidance');
const confirmedList = document.querySelector('#confirmed-list');
const waitlistList = document.querySelector('#waitlist-list');

let currentState = null;
let isSubmitting = false;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败，请稍后重试');
  return result;
}

function setStatus(message, isError = false) {
  formStatus.textContent = message;
  formStatus.style.color = isError ? 'var(--accent-dark)' : 'var(--focus)';
}

function attendeeRow(registration, index) {
  const row = document.createElement('div');
  row.className = 'ledger-row';
  row.dataset.id = registration.id;
  row.setAttribute('role', 'listitem');

  const number = document.createElement('span');
  number.className = 'ledger-index';
  number.textContent = String(index + 1).padStart(2, '0');

  const name = document.createElement('span');
  name.className = 'ledger-name';
  name.textContent = registration.name;

  const email = document.createElement('span');
  email.className = 'ledger-email';
  email.textContent = registration.email;

  const cancel = document.createElement('button');
  cancel.className = 'cancel-action';
  cancel.type = 'button';
  cancel.textContent = '取消';
  const registrationType = registration.status === 'waitlisted' ? '候补登记' : '报名';
  cancel.setAttribute('aria-label', `取消 ${registration.name} 的${registrationType}`);
  cancel.addEventListener('click', () => cancelRegistration(registration.id, row));

  row.append(number, name, email, cancel);
  return row;
}

function renderLedger(list, registrations, emptyMessage) {
  list.replaceChildren();
  if (registrations.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'ledger-empty';
    empty.setAttribute('role', 'listitem');
    empty.textContent = emptyMessage;
    list.append(empty);
  } else {
    registrations.forEach((registration, index) => {
      list.append(attendeeRow(registration, index));
    });
  }
  list.setAttribute('aria-busy', 'false');
}

function updateRegistrationAction() {
  submitButton.disabled = isSubmitting;
  if (!currentState) return;
  const isFull = currentState.remainingSeats === 0;
  submitButton.textContent = isFull ? '加入候补名单' : '确认报名';
  formGuidance.textContent = isFull
    ? '当前名额已满；提交后将按登记顺序加入候补名单。'
    : '提交后即为确认席位。';
}

function render(state) {
  const previousRemaining = currentState?.remainingSeats;
  currentState = state;
  capacity.textContent = state.capacity;
  remainingSeats.textContent = state.remainingSeats;
  confirmedCount.textContent = state.confirmed.length;
  waitlistCount.textContent = state.waitlist.length;
  updateRegistrationAction();

  if (previousRemaining !== undefined && previousRemaining !== state.remainingSeats) {
    remainingSeats.classList.remove('pulse');
    void remainingSeats.offsetWidth;
    remainingSeats.classList.add('pulse');
  }

  renderLedger(confirmedList, state.confirmed, '尚无已确认的报名。');
  renderLedger(waitlistList, state.waitlist, '目前无人候补。');
}

async function cancelRegistration(id, row) {
  row.classList.add('leaving');
  try {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const [result] = await Promise.all([
      api(`/api/registrations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      new Promise((resolve) => window.setTimeout(resolve, reducedMotion ? 0 : 190)),
    ]);
    render(result.state);
    if (result.promoted) {
      setStatus(`已取消 ${result.cancelled.name} 的报名；${result.promoted.name} 已从候补名单自动转为确认。`);
    } else if (result.cancelled.status === 'waitlisted') {
      setStatus(`已将 ${result.cancelled.name} 从候补名单移除。`);
    } else {
      setStatus(`已取消 ${result.cancelled.name} 的报名，席位已经释放。`);
    }
  } catch (error) {
    row.classList.remove('leaving');
    setStatus(error.message, true);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;

  isSubmitting = true;
  updateRegistrationAction();
  setStatus('正在登记…');
  const formData = new FormData(form);
  try {
    const result = await api('/api/registrations', {
      method: 'POST',
      body: JSON.stringify({ name: formData.get('name'), email: formData.get('email') }),
    });
    render(result.state);
    form.reset();
    document.querySelector('#name').focus();
    if (result.registration.status === 'waitlisted') {
      const queuePosition = result.state.waitlist.findIndex(
        (registration) => registration.id === result.registration.id,
      ) + 1;
      setStatus(`已将 ${result.registration.name} 加入候补名单，当前排在第 ${queuePosition} 位。`);
    } else {
      setStatus(`已确认 ${result.registration.name} 的报名。`);
    }
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    isSubmitting = false;
    updateRegistrationAction();
  }
});

api('/api/state')
  .then(render)
  .catch((error) => {
    confirmedList.setAttribute('aria-busy', 'false');
    waitlistList.setAttribute('aria-busy', 'false');
    confirmedList.textContent = '暂时无法载入名册。';
    waitlistList.textContent = '暂时无法载入候补名单。';
    setStatus(error.message, true);
  });
