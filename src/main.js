const sourceLangSelect = document.getElementById('source-lang');
const targetLangSelect = document.getElementById('target-lang');
const swapBtn = document.getElementById('swap-btn');

const sourceText = document.getElementById('source-text');
const targetText = document.getElementById('target-text');

const charCount = document.getElementById('char-count');
const statusText = document.getElementById('status-text');
const clearBtn = document.getElementById('clear-btn');
const copyBtn = document.getElementById('copy-btn');
const translateBtn = document.getElementById('translate-btn');

// Храним прошлые значения, чтобы удобно менять языки при совпадении
let prevSourceLang = sourceLangSelect.value;
let prevTargetLang = targetLangSelect.value;

let debounceTimer = null;
let currentAbortController = null;

// 1. Логика выбора и смены языков
sourceLangSelect.addEventListener('change', () => {
  if (sourceLangSelect.value === targetLangSelect.value) {
    targetLangSelect.value = prevSourceLang;
  }
  prevSourceLang = sourceLangSelect.value;
  prevTargetLang = targetLangSelect.value;

  if (sourceText.value.trim()) {
    handleTranslate();
  }
});

targetLangSelect.addEventListener('change', () => {
  if (targetLangSelect.value === sourceLangSelect.value) {
    sourceLangSelect.value = prevTargetLang;
  }
  prevSourceLang = sourceLangSelect.value;
  prevTargetLang = targetLangSelect.value;

  if (sourceText.value.trim()) {
    handleTranslate();
  }
});

swapBtn.addEventListener('click', () => {
  clearTimeout(debounceTimer);

  // Меняем языки местами
  const tempLang = sourceLangSelect.value;
  sourceLangSelect.value = targetLangSelect.value;
  targetLangSelect.value = tempLang;

  prevSourceLang = sourceLangSelect.value;
  prevTargetLang = targetLangSelect.value;

  // Если уже есть перевод — перекидываем текст и переводим обратно
  if (targetText.value.trim()) {
    sourceText.value = targetText.value;
    targetText.value = '';
    copyBtn.disabled = true;
    updateInputUI();
    handleTranslate();
  } else if (sourceText.value.trim()) {
    handleTranslate();
  }
});

// 2. Обновление счётчика символов и видимости кнопки очистки
function updateInputUI() {
  const length = sourceText.value.length;
  charCount.textContent = `${length} / 5000`;
  clearBtn.hidden = length === 0;
}

sourceText.addEventListener('input', () => {
  updateInputUI();
  clearTimeout(debounceTimer);

  if (!sourceText.value.trim()) {
    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }
    targetText.value = '';
    copyBtn.disabled = true;
    statusText.textContent = '';
    translateBtn.disabled = false;
    return;
  }

  // Автоперевод через 600 мс после окончания ввода
  debounceTimer = setTimeout(() => {
    handleTranslate();
  }, 600);
});

// Мгновенный перевод по Ctrl + Enter (удобно для десктопа)
sourceText.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    clearTimeout(debounceTimer);
    handleTranslate();
  }
});

// 3. Очистка поля
clearBtn.addEventListener('click', () => {
  clearTimeout(debounceTimer);
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }

  sourceText.value = '';
  targetText.value = '';
  copyBtn.disabled = true;
  statusText.textContent = '';
  translateBtn.disabled = false;
  updateInputUI();
  sourceText.focus();
});

// 4. Копирование результата
copyBtn.addEventListener('click', async () => {
  if (!targetText.value) return;

  try {
    await navigator.clipboard.writeText(targetText.value);
    statusText.textContent = 'Скопировано!';
    setTimeout(() => {
      if (statusText.textContent === 'Скопировано!') {
        statusText.textContent = '';
      }
    }, 2000);
  } catch (err) {
    console.error('Ошибка копирования:', err);
    statusText.textContent = 'Не удалось скопировать';
  }
});

// 5. Основная функция перевода
translateBtn.addEventListener('click', () => {
  clearTimeout(debounceTimer);
  handleTranslate();
});

async function handleTranslate() {
  const rawText = sourceText.value;
  if (!rawText.trim()) return;

  // Отменяем предыдущий незавершённый запрос, если он ещё идёт
  if (currentAbortController) {
    currentAbortController.abort();
  }

  currentAbortController = new AbortController();
  const { signal } = currentAbortController;

  const from = sourceLangSelect.value;
  const to = targetLangSelect.value;

  statusText.textContent = 'Перевод...';
  translateBtn.disabled = true;

  try {
    const result = await translateText(rawText, from, to, signal);

    if (signal.aborted) return;

    targetText.value = result;
    copyBtn.disabled = !result;
    statusText.textContent = '';
  } catch (error) {
    if (error.name === 'AbortError') return;

    console.error('Ошибка перевода:', error);
    statusText.textContent = 'Ошибка перевода (проверьте интернет)';
  } finally {
    if (currentAbortController && currentAbortController.signal === signal) {
      translateBtn.disabled = false;
      currentAbortController = null;
    }
  }
}

// Пробуем Google Translate, при сбое — переключаемся на MyMemory
async function translateText(text, from, to, signal) {
  try {
    return await translateWithGoogle(text, from, to, signal);
  } catch (googleError) {
    if (googleError.name === 'AbortError') throw googleError;
    console.warn('Google Translate недоступен, пробуем MyMemory:', googleError);
    return await translateWithMyMemory(text, from, to, signal);
  }
}

async function translateWithGoogle(text, from, to, signal) {
  // Режем по 400 символов, чтобы не превысить лимит длины GET-запроса для кириллицы
  const chunks = splitTextIntoChunks(text, 400);
  const translatedChunks = [];

  for (const chunk of chunks) {
    const leadingWs = chunk.match(/^\s*/)[0];
    const trailingWs = chunk.match(/\s*$/)[0];
    const core = chunk.trim();

    if (!core) {
      translatedChunks.push(chunk);
      continue;
    }

    const url =
      `https://translate.googleapis.com/translate_a/single` +
      `?client=gtx&sl=${encodeURIComponent(from)}&tl=${encodeURIComponent(to)}` +
      `&dt=t&q=${encodeURIComponent(core)}`;

    const response = await fetch(url, { signal });
    if (!response.ok) {
      throw new Error(`Google API HTTP ${response.status}`);
    }

    const data = await response.json();
    const translatedCore = Array.isArray(data?.[0])
      ? data[0].map((part) => (part && part[0] ? part[0] : '')).join('')
      : '';

    translatedChunks.push(`${leadingWs}${translatedCore}${trailingWs}`);
  }

  return translatedChunks.join('');
}

async function translateWithMyMemory(text, from, to, signal) {
  // Лимит MyMemory — 500 байт на запрос; 200 символов кириллицы = ~400 байт в UTF-8
  const chunks = splitTextIntoChunks(text, 200);
  const translatedChunks = [];

  for (const chunk of chunks) {
    const leadingWs = chunk.match(/^\s*/)[0];
    const trailingWs = chunk.match(/\s*$/)[0];
    const core = chunk.trim();

    if (!core) {
      translatedChunks.push(chunk);
      continue;
    }

    const url =
      `https://api.mymemory.translated.net/get` +
      `?q=${encodeURIComponent(core)}&langpair=${encodeURIComponent(`${from}|${to}`)}`;

    const response = await fetch(url, { signal });
    if (!response.ok) {
      throw new Error(`MyMemory HTTP ${response.status}`);
    }

    const data = await response.json();
    if (data.responseStatus !== 200) {
      throw new Error(data.responseDetails || `MyMemory status ${data.responseStatus}`);
    }

    const translatedCore = data.responseData?.translatedText || '';
    translatedChunks.push(`${leadingWs}${translatedCore}${trailingWs}`);
  }

  return translatedChunks.join('');
}

// Разбиение текста на куски без разрыва слов и с сохранением переносов
function splitTextIntoChunks(text, maxLength) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let sliceEnd = maxLength;
    const newlineIdx = remaining.lastIndexOf('\n', maxLength);
    const spaceIdx = remaining.lastIndexOf(' ', maxLength);

    if (newlineIdx > maxLength * 0.3) {
      sliceEnd = newlineIdx + 1;
    } else if (spaceIdx > maxLength * 0.3) {
      sliceEnd = spaceIdx + 1;
    }

    chunks.push(remaining.slice(0, sliceEnd));
    remaining = remaining.slice(sliceEnd);
  }

  return chunks;
}