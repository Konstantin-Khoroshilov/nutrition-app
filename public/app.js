
const form = document.getElementById('goals-form');
const statusElement = document.getElementById('status');
const dateInput = document.getElementById('diaryDate');
const previousDayButton = document.getElementById('previousDay');
const nextDayButton = document.getElementById('nextDay');
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
let catalogElement;
let searchInput;
let searchCount;
let catalogList;
let dailyTotalsReady = false;

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

    } catch (error) {
        statusElement.textContent = error.message;
    }
});

// Создаём единый каталог меню
function createCatalog() {
    catalogElement = document.createElement('section');
    catalogElement.className = 'menu-catalog';

    const heading = document.createElement('h2');
    heading.textContent = 'Меню Freshvote';

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
    catalogElement.appendChild(searchInput);
    catalogElement.appendChild(searchCount);
    catalogElement.appendChild(catalogList);

    // Размещаем каталог перед приёмами пищи
    mealsElement.parentElement.insertBefore(
        catalogElement,
        mealsElement
    );
}

// Загружаем меню с сервера
async function loadMenu() {
    try {
        const response = await fetch('/api/menu');

        if (!response.ok) {
            throw new Error('Не удалось загрузить меню');
        }

        const data = await response.json();

        menuDishes = data.dishes || [];

        renderCatalog();

    } catch (error) {
        if (catalogList) {
            catalogList.textContent = error.message;
        }
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
        catalogList.textContent = 'Ничего не найдено';
        return;
    }

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
            dish.nutrition_status !== 'menu' ||
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
    await loadMenu();
    await loadDiary();
}

init();
