
const form = document.getElementById('goals-form');
const statusElement = document.getElementById('status');
const dateInput = document.getElementById('diaryDate');
const previousDayButton = document.getElementById('previousDay');
const nextDayButton = document.getElementById('nextDay');
const menuStatus = document.getElementById('menuStatus');
const clearMenuButton = document.getElementById('clear-menu-button');
const openMealPlanButton = document.getElementById('open-meal-plan');
const mealPlanDialog = document.getElementById('meal-plan-dialog');
const mealPlanMenuOptions = document.getElementById('meal-plan-menu-options');
const mealPlanDialogStatus = document.getElementById('meal-plan-dialog-status');
const generateMealPlanButton = document.getElementById('generate-meal-plan');
const mealPlanResults = document.getElementById('meal-plan-results');
const mealPlanSummary = document.getElementById('meal-plan-summary');
const mealPlanList = document.getElementById('meal-plan-list');
const mealPlanResultStatus = document.getElementById('meal-plan-result-status');
const manualMenuPanel = document.getElementById('manual-menu-panel');
const manualDishForm = document.getElementById('manual-dish-form');
const mealsElement = document.getElementById('meals');
const totalsElement = document.getElementById('totals');
const warningElement = document.getElementById('approximateWarning');
const dailyTotalsPanel = document.getElementById('dailyTotalsPanel');
const stickyDailyTotals = document.getElementById('stickyDailyTotals');

const mealNames = {
    breakfast: 'Завтрак',
    lunch: 'Обед',
    snack: 'Перекус',
    dinner: 'Ужин'
};

const nutrientNames = {
    calories: 'Калории',
    protein: 'Белки',
    fat: 'Жиры',
    carbs: 'Углеводы'
};

const nutrientUnits = {
    calories: 'ккал',
    protein: 'г',
    fat: 'г',
    carbs: 'г'
};

let menuDishes = [];
let menus = [];
let currentMenu = null;
let menuMode = 'url';
let menuLoading = false;
let menuProcessing = false;
let mealPlanGenerating = false;
let mealPlanApplying = false;
let menuLoadToken = 0;
let generatedMealPlan = null;
let appliedMealPlanId = null;
let activeMenuName;
let activeMenuDate;
let catalogElement;
let searchInput;
let searchCount;
let catalogList;
let dailyTotalsReady = false;

function setMenuStatus(message, isLoading = false) {
    menuStatus.textContent = message;
    menuStatus.classList.toggle('is-loading', isLoading);
    menuStatus.setAttribute('aria-busy', String(isLoading));
}

function updateMenuActionState() {
    const actionsDisabled = menuProcessing || mealPlanGenerating ||
        mealPlanApplying;

    document.querySelectorAll('[data-menu-mode]').forEach(button => {
        button.disabled = actionsDisabled;
    });
    clearMenuButton.disabled = actionsDisabled || menuLoading || !currentMenu;
    openMealPlanButton.disabled = actionsDisabled ||
        !menus.some(menu => Number(menu.dish_count) > 0);
}

function setMenuProcessing(isProcessing) {
    menuProcessing = isProcessing;
    updateMenuActionState();
}

function updateStickyDailyTotalsVisibility() {
    const hasScrolledPastTotals =
        dailyTotalsPanel.getBoundingClientRect().bottom <= 0;

    stickyDailyTotals.classList.toggle(
        'hidden',
        !dailyTotalsReady || !hasScrolledPastTotals
    );
}

window.addEventListener('scroll', updateStickyDailyTotalsVisibility, {
    passive: true
});
window.addEventListener('resize', updateStickyDailyTotalsVisibility);

// Получаем сегодняшнюю дату
function getToday() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
}

function changeDiaryDate(dayOffset) {
    const [year, month, day] = (dateInput.value || getToday())
        .split('-')
        .map(Number);
    const date = new Date(Date.UTC(year, month - 1, day + dayOffset));

    dateInput.value = date.toISOString().slice(0, 10);
    loadDiary();
}

// Форматируем числа
function formatNumber(value) {
    if (value === null || value === undefined) {
        return 'нет данных';
    }

    return Number(value).toLocaleString('ru-RU', {
        maximumFractionDigits: 1
    });
}

// Загружаем сохранённые цели
async function loadGoals() {
    try {
        const response = await fetch('/api/goals');

        if (!response.ok) {
            throw new Error('Не удалось загрузить цели');
        }

        const goals = await response.json();

        if (goals) {
            document.getElementById('calories').value = goals.calories;
            document.getElementById('protein').value = goals.protein;
            document.getElementById('fat').value = goals.fat;
            document.getElementById('carbs').value = goals.carbs;

            statusElement.textContent =
                'Загружены ранее сохранённые цели';
        }
    } catch (error) {
        statusElement.textContent = error.message;
    }
}

// Сохраняем цели
form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const goals = {
        diary_date: dateInput.value,
        calories: Number(document.getElementById('calories').value),
        protein: Number(document.getElementById('protein').value),
        fat: Number(document.getElementById('fat').value),
        carbs: Number(document.getElementById('carbs').value)
    };

    try {
        const response = await fetch('/api/goals', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(goals)
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || 'Ошибка сохранения');
        }

        statusElement.textContent = 'Цели успешно сохранены';
        await loadDiary();
        clearMealPlanResults();

    } catch (error) {
        statusElement.textContent = error.message;
    }
});

// Создаём каталог блюд выбранного меню
function createCatalog() {
    catalogElement = document.createElement('section');
    catalogElement.className = 'menu-catalog';

    const heading = document.createElement('h2');
    heading.textContent = 'Блюда меню';

    const menuInfo = document.createElement('div');
    menuInfo.className = 'menu-current-info';
    activeMenuName = document.createElement('strong');
    activeMenuName.id = 'activeMenuName';
    activeMenuName.setAttribute('aria-live', 'polite');
    activeMenuDate = document.createElement('small');
    activeMenuDate.id = 'activeMenuDate';
    activeMenuDate.className = 'hidden';
    menuInfo.appendChild(activeMenuName);
    menuInfo.appendChild(activeMenuDate);

    searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'dish-search';
    searchInput.placeholder = 'Поиск по названию блюда...';

    searchCount = document.createElement('p');
    searchCount.className = 'search-count';

    catalogList = document.createElement('div');
    catalogList.className = 'catalog-list';

    searchInput.addEventListener('input', renderCatalog);

    catalogElement.appendChild(heading);
    catalogElement.appendChild(menuInfo);
    catalogElement.appendChild(searchInput);
    catalogElement.appendChild(searchCount);
    catalogElement.appendChild(catalogList);

    // Размещаем каталог перед приёмами пищи
    mealsElement.parentElement.insertBefore(
        catalogElement,
        mealsElement
    );
}

function getMenuSource(mode) {
    return {
        url: 'image_url',
        upload: 'image_upload',
        manual: 'manual'
    }[mode];
}

function updateActiveMenuInfo() {
    const emptyLabels = {
        url: 'Меню по ссылке не загружено',
        upload: 'Меню с изображения не загружено',
        manual: 'Моё меню'
    };
    activeMenuName.textContent = currentMenu
        ? currentMenu.name
        : emptyLabels[menuMode];
    const recognizedAt = currentMenu?.recognized_at
        ? new Date(currentMenu.recognized_at)
        : null;
    const recognizedLabel = recognizedAt && !Number.isNaN(recognizedAt.getTime())
        ? `Распознано: ${recognizedAt.toLocaleString('ru-RU', {
            dateStyle: 'short',
            timeStyle: 'short'
        })}`
        : '';
    activeMenuDate.textContent = recognizedLabel;
    activeMenuDate.classList.toggle('hidden', !recognizedLabel);
    updateManualDishForm();
    updateMenuActionState();
}

function updateManualDishForm() {
    const canAddDish = menuMode === 'manual' &&
        currentMenu?.source === 'manual';

    manualDishForm.classList.toggle('hidden', !canAddDish);
}

async function openMyMenu() {
    if (menus.some(menu => menu.source === 'manual')) {
        await loadMenuForMode();
        return;
    }

    setMenuStatus('Открываем «Моё меню»...', true);

    try {
        const response = await fetch('/api/menus/manual', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Моё меню' })
        });
        const menu = await response.json();

        if (!response.ok) {
            throw new Error(menu.error || 'Не удалось открыть «Моё меню»');
        }

        await loadMenus();
        setMenuStatus('Добавляйте блюда в «Моё меню».');
    } catch (error) {
        setMenuStatus(error.message);
    }
}

async function loadMenuForMode() {
    const loadToken = ++menuLoadToken;
    const loadingMode = menuMode;
    const source = getMenuSource(loadingMode);
    const menuSummary = menus.find(menu =>
        menu.source === source ||
        (loadingMode === 'url' && menu.source === 'saved')
    );

    menuLoading = true;
    currentMenu = null;
    menuDishes = [];
    if (searchInput) {
        searchInput.value = '';
    }

    updateActiveMenuInfo();
    updateMenuActionState();

    if (!menuSummary) {
        menuLoading = false;
        updateMenuActionState();
        renderCatalog();
        return;
    }

    if (catalogList) {
        catalogList.textContent = 'Загружаем меню...';
    }

    try {
        const response = await fetch(`/api/menus/${menuSummary.id}`);
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Не удалось загрузить меню');
        }

        if (
            loadToken !== menuLoadToken ||
            menuMode !== loadingMode
        ) {
            return;
        }

        currentMenu = data;
        menuDishes = data.dishes;
        updateActiveMenuInfo();
        renderCatalog();
    } catch (error) {
        if (
            loadToken === menuLoadToken &&
            menuMode === loadingMode &&
            catalogList
        ) {
            catalogList.textContent = error.message;
        }
    } finally {
        if (loadToken === menuLoadToken) {
            menuLoading = false;
            updateManualDishForm();
            updateMenuActionState();
        }
    }
}

async function loadMenus() {
    const response = await fetch('/api/menus');
    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.error || 'Не удалось загрузить список меню');
    }

    menus = data.sort((first, second) => Number(second.id) - Number(first.id));
    await loadMenuForMode();
}

function setMealPlanStatus(element, message, isLoading = false) {
    element.textContent = message;
    element.classList.toggle('is-loading', isLoading);
    element.setAttribute('aria-busy', String(isLoading));
}

function updateMealPlanGenerateButton() {
    const selectedCount = mealPlanMenuOptions.querySelectorAll(
        'input[name="meal-plan-menu"]:checked'
    ).length;

    generateMealPlanButton.disabled = mealPlanGenerating ||
        selectedCount < 1 ||
        selectedCount > 3;
}

function clearMealPlanResults() {
    generatedMealPlan = null;
    appliedMealPlanId = null;
    mealPlanList.replaceChildren();
    mealPlanResults.classList.add('hidden');
    mealPlanSummary.textContent = '';
    setMealPlanStatus(mealPlanResultStatus, '');
}

function openMealPlanChooser() {
    const availableMenus = menus.filter(menu => Number(menu.dish_count) > 0);

    if (availableMenus.length === 0) {
        return;
    }

    clearMealPlanResults();
    mealPlanMenuOptions.replaceChildren();
    setMealPlanStatus(mealPlanDialogStatus, '');

    const sourceLabels = {
        image_url: 'По ссылке',
        image_upload: 'С изображения',
        manual: 'Моё меню'
    };

    for (const menu of availableMenus) {
        const label = document.createElement('label');
        label.className = 'meal-plan-menu-option';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.name = 'meal-plan-menu';
        checkbox.value = String(menu.id);
        checkbox.addEventListener('change', updateMealPlanGenerateButton);

        const text = document.createElement('span');
        text.textContent =
            `${menu.name} · ${sourceLabels[menu.source] || menu.source} · ` +
            `${menu.dish_count} блюд`;

        label.append(checkbox, text);
        mealPlanMenuOptions.appendChild(label);
    }

    updateMealPlanGenerateButton();
    mealPlanDialog.showModal();
}

function formatPlanPercent(value) {
    const prefix = value > 0 ? '+' : '';
    return `${prefix}${formatNumber(value)}%`;
}

function createMealPlanCard(plan, planData) {
    const card = document.createElement('article');
    card.className = 'meal-plan-card';

    const title = document.createElement('h3');
    title.textContent = plan.title;
    card.appendChild(title);

    const tolerance = document.createElement('p');
    tolerance.className = plan.within_tolerance
        ? 'meal-plan-tolerance within'
        : 'meal-plan-tolerance outside';
    tolerance.textContent = plan.within_tolerance
        ? `Все показатели в пределах ±${planData.tolerance_percent}%`
        : `Некоторые показатели выходят за ±${planData.tolerance_percent}%`;
    card.appendChild(tolerance);

    const meals = document.createElement('div');
    meals.className = 'meal-plan-meals';

    for (const [mealType, mealName] of Object.entries(mealNames)) {
        const meal = document.createElement('section');
        meal.className = 'meal-plan-meal';

        const heading = document.createElement('h4');
        heading.textContent = mealName;
        meal.appendChild(heading);

        const items = plan.meals[mealType];

        if (items.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'meal-plan-empty';
            empty.textContent = 'Блюда не выбраны';
            meal.appendChild(empty);
        } else {
            const list = document.createElement('ul');
            const mealTotals = {
                calories: 0,
                protein: 0,
                fat: 0,
                carbs: 0
            };

            for (const item of items) {
                const listItem = document.createElement('li');
                listItem.textContent =
                    `${item.name} — ${item.servings} порц. · ` +
                    `${formatNumber(item.portion_weight_g)} г · ` +
                    `${formatNumber(item.calories)} ккал`;
                list.appendChild(listItem);

                for (const nutrient of Object.keys(mealTotals)) {
                    mealTotals[nutrient] += item[nutrient];
                }
            }

            meal.appendChild(list);

            const totals = document.createElement('p');
            totals.className = 'meal-plan-meal-totals';
            totals.textContent =
                `${formatNumber(mealTotals.calories)} ккал · ` +
                `Б ${formatNumber(mealTotals.protein)} г · ` +
                `Ж ${formatNumber(mealTotals.fat)} г · ` +
                `У ${formatNumber(mealTotals.carbs)} г`;
            meal.appendChild(totals);
        }

        meals.appendChild(meal);
    }

    card.appendChild(meals);

    const totalsHeading = document.createElement('h4');
    totalsHeading.className = 'meal-plan-totals-heading';
    totalsHeading.textContent = 'Итого за день и отклонение от цели';
    card.appendChild(totalsHeading);

    const totals = document.createElement('dl');
    totals.className = 'meal-plan-totals';

    for (const nutrient of ['calories', 'protein', 'fat', 'carbs']) {
        const term = document.createElement('dt');
        term.textContent = nutrientNames[nutrient];

        const value = document.createElement('dd');
        const unit = nutrientUnits[nutrient];
        const deviation = plan.deviations[nutrient];
        value.textContent =
            `${formatNumber(plan.totals[nutrient])} / ` +
            `${formatNumber(planData.goals[nutrient])} ${unit} ` +
            `(${formatPlanPercent(deviation.percent)})`;

        totals.append(term, value);
    }

    card.appendChild(totals);

    const applyButton = document.createElement('button');
    applyButton.type = 'button';
    applyButton.className = 'meal-plan-apply';
    applyButton.textContent = 'Добавить вариант в дневник';
    applyButton.disabled = appliedMealPlanId !== null;
    applyButton.addEventListener('click', () =>
        applyMealPlan(plan, planData)
    );
    card.appendChild(applyButton);

    return card;
}

function renderMealPlans(planData) {
    generatedMealPlan = planData;
    appliedMealPlanId = null;
    mealPlanList.replaceChildren();

    const sourceList = planData.menu_names.join(', ');
    const excludedMessage = planData.excluded_dish_count > 0
        ? ` Исключено блюд с неполным КБЖУ: ${planData.excluded_dish_count}.`
        : '';
    mealPlanSummary.textContent =
        `Дата: ${planData.date} · Меню: ${sourceList}.${excludedMessage}`;

    for (const plan of planData.plans) {
        mealPlanList.appendChild(createMealPlanCard(plan, planData));
    }

    mealPlanResults.classList.remove('hidden');
}

async function generateMealPlan() {
    const menuIds = Array.from(
        mealPlanMenuOptions.querySelectorAll(
            'input[name="meal-plan-menu"]:checked'
        ),
        checkbox => Number(checkbox.value)
    );

    if (menuIds.length < 1 || menuIds.length > 3) {
        setMealPlanStatus(mealPlanDialogStatus, 'Выберите от одного до трёх меню.');
        return;
    }

    mealPlanGenerating = true;
    updateMenuActionState();
    updateMealPlanGenerateButton();
    mealPlanMenuOptions.querySelectorAll('input').forEach(input => {
        input.disabled = true;
    });
    document.getElementById('cancel-meal-plan').disabled = true;
    setMealPlanStatus(
        mealPlanDialogStatus,
        'Gemini подбирает блюда и рассчитывает варианты. Это может занять некоторое время.',
        true
    );

    const date = dateInput.value;

    try {
        const response = await fetch('/api/meal-plans', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date, menu_ids: menuIds })
        });
        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || 'Не удалось составить план питания');
        }

        mealPlanDialog.close();
        renderMealPlans(result);
        mealPlanResults.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
        setMealPlanStatus(mealPlanDialogStatus, error.message);
    } finally {
        mealPlanGenerating = false;
        mealPlanMenuOptions.querySelectorAll('input').forEach(input => {
            input.disabled = false;
        });
        document.getElementById('cancel-meal-plan').disabled = false;
        updateMenuActionState();
        updateMealPlanGenerateButton();
    }
}

async function applyMealPlan(plan, planData) {
    if (mealPlanApplying || appliedMealPlanId !== null) {
        return;
    }

    const entries = Object.entries(plan.meals).flatMap(([mealType, dishes]) =>
        dishes.map(dish => ({
            dish_id: dish.dish_id,
            meal_type: mealType,
            servings: dish.servings
        }))
    );

    mealPlanApplying = true;
    mealPlanList.querySelectorAll('.meal-plan-apply').forEach(button => {
        button.disabled = true;
    });
    updateMenuActionState();
    setMealPlanStatus(mealPlanResultStatus, 'Добавляем план в дневник...', true);

    try {
        const response = await fetch('/api/meal-plans/apply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                date: planData.date,
                menu_ids: planData.menu_ids,
                entries
            })
        });
        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || 'Не удалось добавить план в дневник');
        }

        appliedMealPlanId = plan.id;
        dateInput.value = planData.date;
        await loadDiary();
        mealPlanList.querySelectorAll('.meal-plan-apply').forEach(button => {
            button.disabled = true;
        });
        setMealPlanStatus(
            mealPlanResultStatus,
            `План добавлен в дневник за ${planData.date}.`
        );
    } catch (error) {
        mealPlanList.querySelectorAll('.meal-plan-apply').forEach(button => {
            button.disabled = appliedMealPlanId !== null;
        });
        setMealPlanStatus(mealPlanResultStatus, error.message);
    } finally {
        mealPlanApplying = false;
        updateMenuActionState();
    }
}

function setMenuMode(mode) {
    menuMode = mode;

    document.querySelectorAll('[data-menu-mode]').forEach(button => {
        button.setAttribute(
            'aria-pressed',
            String(button.dataset.menuMode === mode)
        );
    });

    document.getElementById('url-menu-form')
        .classList.toggle('hidden', mode !== 'url');
    document.getElementById('upload-menu-form')
        .classList.toggle('hidden', mode !== 'upload');
    manualMenuPanel.classList.toggle('hidden', mode !== 'manual');
    setMenuStatus('');
    updateActiveMenuInfo();
    updateManualDishForm();
}

async function postMenuForm(
    form,
    endpoint,
    payload,
    progressMessage,
    preparePayload
) {
    const submitButton = form.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    setMenuProcessing(true);

    try {
        if (preparePayload) {
            setMenuStatus('Подготавливаем изображение...', true);
            payload = await preparePayload();
        }

        setMenuStatus(progressMessage, true);
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || 'Не удалось сохранить меню');
        }

        await loadMenus();
        form.reset();
        clearMealPlanResults();
        setMenuStatus(`Меню «${result.name}» добавлено.`);
        return result;
    } catch (error) {
        setMenuStatus(error.message);
        return null;
    } finally {
        submitButton.disabled = false;
        setMenuProcessing(false);
    }
}

async function readImageFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Не удалось прочитать изображение'));
        reader.readAsDataURL(file);
    });
}

document.querySelectorAll('[data-menu-mode]').forEach(button => {
    button.addEventListener('click', () => {
        const mode = button.dataset.menuMode;
        setMenuMode(mode);

        if (mode === 'manual') {
            openMyMenu();
        } else {
            loadMenuForMode();
        }
    });
});

clearMenuButton.addEventListener('click', clearActiveMenu);
openMealPlanButton.addEventListener('click', openMealPlanChooser);
generateMealPlanButton.addEventListener('click', generateMealPlan);
document.getElementById('cancel-meal-plan').addEventListener('click', () => {
    mealPlanDialog.close();
});
mealPlanDialog.addEventListener('cancel', event => {
    if (mealPlanGenerating) {
        event.preventDefault();
    }
});

document.getElementById('url-menu-form').addEventListener('submit', event => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);

    postMenuForm(event.currentTarget, '/api/menus/recognize', {
        name: fields.get('name'),
        url: fields.get('url')
    }, 'Загружаем изображение по ссылке и распознаём меню. Это может занять некоторое время.');
});

document.getElementById('upload-menu-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const file = fields.get('image');

    if (!file || file.size === 0) {
        setMenuStatus('Выберите изображение меню.');
        return;
    }

    if (file.size > 10 * 1024 * 1024) {
        setMenuStatus('Размер изображения должен быть не более 10 МБ.');
        return;
    }

    postMenuForm(form, '/api/menus/recognize', {
        name: fields.get('name')
    }, 'Распознаём изображение меню. Это может занять некоторое время.', async () => {
        const imageData = await readImageFile(file);
        return {
            name: fields.get('name'),
            imageData
        };
    });
});

manualDishForm.addEventListener('submit', async event => {
    event.preventDefault();
    const activeMenu = currentMenu;

    if (!activeMenu || activeMenu.source !== 'manual') {
        setMenuStatus('Сначала выберите собственное меню.');
        return;
    }

    const form = event.currentTarget;
    const fields = new FormData(form);
    const dish = {
        name: fields.get('name'),
        portion_weight_g: Number(fields.get('portion_weight_g')),
        calories: Number(fields.get('calories')),
        protein: Number(fields.get('protein')),
        fat: Number(fields.get('fat')),
        carbs: Number(fields.get('carbs'))
    };
    const submitButton = form.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    setMenuStatus('Добавляем блюдо...', true);

    try {
        const response = await fetch(`/api/menus/${activeMenu.id}/dishes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(dish)
        });
        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || 'Не удалось добавить блюдо');
        }

        form.reset();
        await loadMenus();
        clearMealPlanResults();
        setMenuStatus(`Блюдо «${dish.name}» добавлено в меню.`);
    } catch (error) {
        setMenuStatus(error.message);
    } finally {
        submitButton.disabled = false;
    }
});

async function deleteMenuDish(menuId, dish) {
    if (!window.confirm(`Удалить «${dish.name}» из «Моего меню»?`)) {
        return;
    }

    try {
        const response = await fetch(
            `/api/menus/${menuId}/dishes/${dish.id}`,
            { method: 'DELETE' }
        );
        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || 'Не удалось удалить блюдо');
        }

        await loadMenus();
        clearMealPlanResults();
        setMenuStatus(`Блюдо «${dish.name}» удалено из «Моего меню».`);
    } catch (error) {
        setMenuStatus(error.message);
    }
}

async function clearActiveMenu() {
    const menu = currentMenu;

    if (!menu || menuProcessing || menuLoading) {
        return;
    }

    const confirmed = window.confirm(
        `Удалить все сохранённые версии «${menu.name}» и их блюда? ` +
        'Меню других источников и записи дневника останутся.'
    );

    if (!confirmed) {
        return;
    }

    setMenuProcessing(true);
    setMenuStatus(`Очищаем «${menu.name}»...`, true);

    try {
        const response = await fetch(
            `/api/menus/source/${encodeURIComponent(menu.source)}`,
            { method: 'DELETE' }
        );
        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || 'Не удалось очистить меню');
        }

        await loadMenus();
        clearMealPlanResults();
        setMenuStatus(
            `Меню «${menu.name}» очищено. Удалено блюд: ${result.deleted_dishes}.`
        );
    } catch (error) {
        setMenuStatus(error.message);
    } finally {
        setMenuProcessing(false);
    }
}

// Отображаем каталог
function renderCatalog() {
    if (!catalogList) return;

    const searchValue = searchInput.value
        .trim()
        .toLocaleLowerCase('ru');

    const filteredDishes = menuDishes.filter(dish =>
        dish.name.toLocaleLowerCase('ru').includes(searchValue)
    );

    searchCount.textContent =
        `Найдено блюд: ${filteredDishes.length}`;

    catalogList.innerHTML = '';

    if (filteredDishes.length === 0) {
        catalogList.textContent = !currentMenu
            ? ({
                url: 'Загрузите меню по ссылке, чтобы увидеть его блюда.',
                upload: 'Загрузите изображение меню, чтобы увидеть распознанные блюда.',
                manual: 'В «Моём меню» пока нет блюд.'
            }[menuMode])
            : searchValue
                ? 'Ничего не найдено'
                : 'В этом меню пока нет блюд.';
        return;
    }

    const activeMenu = currentMenu;

    for (const dish of filteredDishes) {
        const item = document.createElement('div');
        item.className = 'catalog-item';

        const description = document.createElement('div');
        description.className = 'catalog-description';

        const name = document.createElement('strong');
        name.textContent = dish.name;

        const details = document.createElement('p');

        const weight = dish.portion_weight_g !== null
            ? `${formatNumber(dish.portion_weight_g)} г`
            : 'Вес не указан';

        details.textContent =
            `${weight} · ` +
            `${formatNumber(dish.calories)} ккал · ` +
            `Б ${formatNumber(dish.protein)} · ` +
            `Ж ${formatNumber(dish.fat)} · ` +
            `У ${formatNumber(dish.carbs)}`;

        description.appendChild(name);
        description.appendChild(details);

        const isApproximate =
            !['menu', 'manual'].includes(dish.nutrition_status) ||
            dish.missing_fields.length > 0;

        if (isApproximate) {
            const mark = document.createElement('small');
            mark.textContent = 'Есть приблизительные или отсутствующие данные';
            description.appendChild(mark);
        }

        
        const controls = document.createElement('div');
        controls.className = 'catalog-controls';

        // Количество порций
        const quantityInput = document.createElement('input');
        quantityInput.type = 'number';
        quantityInput.min = '1';
        quantityInput.step = '1';
        quantityInput.value = '1';
        quantityInput.className = 'quantity-input';
        quantityInput.title = 'Количество порций';

        // Выбор приёма пищи
        const mealSelect = document.createElement('select');
        mealSelect.className = 'meal-select';

        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Приём пищи';
        placeholder.selected = true;

        mealSelect.appendChild(placeholder);

        for (const [mealType, mealName] of Object.entries(mealNames)) {
            const option = document.createElement('option');
            option.value = mealType;
            option.textContent = mealName;
            mealSelect.appendChild(option);
        }

        // Кнопка добавления
        const addButton = document.createElement('button');
        addButton.type = 'button';
        addButton.textContent = 'Добавить';
        addButton.disabled = true;

        mealSelect.addEventListener('change', () => {
            addButton.disabled = !mealSelect.value;
        });

        addButton.addEventListener('click', async () => {
            const quantity = Number(quantityInput.value);

            if (!mealSelect.value || !Number.isInteger(quantity) || quantity < 1) {
                alert('Укажи корректное количество порций и приём пищи.');
                return;
            }

            addButton.disabled = true;

            await addDish(mealSelect.value, dish, quantity);

            // Сбрасываем выбор после добавления
            quantityInput.value = '1';
            mealSelect.value = '';
            addButton.disabled = true;
        });

        controls.appendChild(quantityInput);
        controls.appendChild(mealSelect);
        controls.appendChild(addButton);

        if (activeMenu?.source === 'manual') {
            const removeButton = document.createElement('button');
            removeButton.type = 'button';
            removeButton.className = 'remove-menu-dish';
            removeButton.textContent = 'Удалить';
            removeButton.setAttribute(
                'aria-label',
                `Удалить ${dish.name} из Моего меню`
            );
            removeButton.addEventListener('click', () =>
                deleteMenuDish(activeMenu.id, dish)
            );
            controls.appendChild(removeButton);
        }

        item.appendChild(description);
        item.appendChild(controls);

        catalogList.appendChild(item);
    }
}

// Загружаем дневник за выбранную дату
async function loadDiary() {
    const date = dateInput.value;

    if (!date) return;

    dailyTotalsReady = false;
    stickyDailyTotals.classList.add('hidden');
    mealsElement.textContent = 'Загрузка...';

    try {
        const response = await fetch(
            `/api/diary?date=${encodeURIComponent(date)}`
        );

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Ошибка загрузки дневника');
        }

        renderMeals(data.entries);
        renderTotals(data.totals, data.goals, data.approximate);

    } catch (error) {
        mealsElement.textContent = error.message;
    }
}

// Отображаем приёмы пищи

function renderMeals(entries) {
    mealsElement.innerHTML = '';

    for (const [mealType, mealName] of Object.entries(mealNames)) {
        const mealEntries = entries.filter(
            entry => entry.meal_type === mealType
        );

        const section = document.createElement('section');
        section.className = 'meal';

        // Заголовок и итоги приёма пищи
        const heading = document.createElement('h3');
        heading.className = 'meal-heading';

        // Рассчитываем промежуточные итоги
        const nutrients = ['calories', 'protein', 'fat', 'carbs'];

        const mealTotals = {};

        for (const nutrient of nutrients) {
            const knownValues = mealEntries
                .map(entry => entry[nutrient])
                .filter(value => value !== null && value !== undefined);

            mealTotals[nutrient] = knownValues.length > 0
                ? knownValues.reduce((sum, value) => sum + Number(value), 0)
                : null;
        }

        heading.textContent =
            `${mealName}: ${formatNumber(mealTotals.calories)} ккал · ` +
            `Б ${formatNumber(mealTotals.protein)} г · ` +
            `Ж ${formatNumber(mealTotals.fat)} г · ` +
            `У ${formatNumber(mealTotals.carbs)} г`;

        const hasApproximateData = mealEntries.some(entry =>
            entry.nutrition_status === 'approximate' ||
            nutrients.some(nutrient =>
                entry[nutrient] === null || entry[nutrient] === undefined
            )
        );

        if (hasApproximateData) {
            const mark = document.createElement('span');
            mark.className = 'approximate-icon';
            mark.textContent = '!';
            mark.title = 'Есть приблизительные или отсутствующие данные';
            mark.setAttribute('aria-label', mark.title);
            mark.setAttribute('role', 'img');
            heading.appendChild(mark);
        }

        section.appendChild(heading);

        if (mealEntries.length === 0) {
            const empty = document.createElement('p');
            empty.textContent = 'Пока нет добавленных блюд';
            section.appendChild(empty);
        }

        for (const entry of mealEntries) {
            const item = document.createElement('div');
            item.className = 'dish-item';

            const description = document.createElement('div');

            const name = document.createElement('strong');
            name.textContent = entry.dish_name;

            const details = document.createElement('p');
            details.textContent =
                `${formatNumber(entry.portion_weight_g)} г · ` +
                `${entry.calories === null
                    ? 'калории неизвестны'
                    : formatNumber(entry.calories) + ' ккал'} · ` +
                `Б ${formatNumber(entry.protein)} г · ` +
                `Ж ${formatNumber(entry.fat)} г · ` +
                `У ${formatNumber(entry.carbs)} г`;

            description.appendChild(name);
            description.appendChild(details);

            if (entry.nutrition_status === 'approximate') {
                const mark = document.createElement('small');
                mark.textContent = 'Приблизительные данные';
                description.appendChild(mark);
            }

            const deleteButton = document.createElement('button');
            deleteButton.type = 'button';
            deleteButton.textContent = 'Удалить';

            deleteButton.addEventListener('click', () => {
                deleteEntry(entry.id);
            });

            item.appendChild(description);
            item.appendChild(deleteButton);
            section.appendChild(item);
        }

        mealsElement.appendChild(section);
    }
}


// Отображаем итоги за день
function renderTotals(totals, goals, approximate) {
    totalsElement.innerHTML = '';
    dailyTotalsReady = false;
    stickyDailyTotals.classList.add('hidden');

    if (!goals) {
        totalsElement.textContent =
            'Сначала укажи и сохрани дневные цели.';
        warningElement.classList.add('hidden');
        return;
    }

    const nutrients = ['calories', 'protein', 'fat', 'carbs'];

    for (const nutrient of nutrients) {
        const consumed = totals[nutrient];
        const goal = goals[nutrient];
        const remaining = goal - consumed;

        const item = document.createElement('div');
        item.className = 'total-item';

        const title = document.createElement('strong');
        title.textContent = nutrientNames[nutrient];

        const amount = document.createElement('p');
        amount.textContent =
            `${formatNumber(consumed)} / ${formatNumber(goal)} ${nutrientUnits[nutrient]}`;

        const difference = document.createElement('p');

        if (remaining >= 0) {
            difference.textContent =
                `Осталось: ${formatNumber(remaining)} ${nutrientUnits[nutrient]}`;
        } else {
            difference.textContent =
                `Превышение: ${formatNumber(Math.abs(remaining))} ${nutrientUnits[nutrient]}`;
        }

        item.appendChild(title);
        item.appendChild(amount);
        item.appendChild(difference);

        totalsElement.appendChild(item);
    }

    warningElement.classList.toggle('hidden', !approximate);

    const formatTotalWithDeviation = nutrient => {
        const difference = totals[nutrient] - goals[nutrient];
        const signedDifference = difference > 0
            ? `+${formatNumber(difference)}`
            : formatNumber(difference);

        return `${formatNumber(totals[nutrient])} (${signedDifference})`;
    };

    stickyDailyTotals.textContent =
        `Итого за день: ${formatTotalWithDeviation('calories')} ккал · ` +
        `Б ${formatTotalWithDeviation('protein')} г · ` +
        `Ж ${formatTotalWithDeviation('fat')} г · ` +
        `У ${formatTotalWithDeviation('carbs')} г`;
    dailyTotalsReady = true;
    updateStickyDailyTotalsVisibility();
}

// Добавляем блюдо в выбранный приём пищи

async function addDish(mealType, dish, quantity = 1) {
    const multiply = value =>
        value === null || value === undefined
            ? null
            : Number(value) * quantity;

    const data = {
        diary_date: dateInput.value,
        meal_type: mealType,
        dish_name: quantity > 1
            ? `${dish.name} (${quantity} порции)`
            : dish.name,
        portion_weight_g: multiply(dish.portion_weight_g),
        calories: multiply(dish.calories),
        protein: multiply(dish.protein),
        fat: multiply(dish.fat),
        carbs: multiply(dish.carbs),
        missing_fields: dish.missing_fields || [],
        nutrition_status:
            dish.nutrition_status === 'menu' ? 'menu' : 'estimated'
    };

    try {
        const response = await fetch('/api/diary/entries', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || 'Не удалось добавить блюдо');
        }

        await loadDiary();

    } catch (error) {
        alert(error.message);
    }
}


// Удаляем блюдо
async function deleteEntry(id) {
    try {
        const response = await fetch(`/api/diary/entries/${id}`, {
            method: 'DELETE'
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || 'Не удалось удалить блюдо');
        }

        await loadDiary();

    } catch (error) {
        alert(error.message);
    }
}

// При смене даты загружаем другой дневник
dateInput.addEventListener('change', loadDiary);
previousDayButton.addEventListener('click', () => changeDiaryDate(-1));
nextDayButton.addEventListener('click', () => changeDiaryDate(1));

// Запускаем приложение
async function init() {
    dateInput.value = getToday();

    createCatalog();

    await loadGoals();
    try {
        await loadMenus();
    } catch (error) {
        setMenuStatus(error.message);
        if (catalogList) {
            catalogList.textContent = error.message;
        }
    }
    await loadDiary();
}

init();
