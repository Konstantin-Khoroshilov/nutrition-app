require('dotenv').config();

const MEAL_TYPES = ['breakfast', 'lunch', 'snack', 'dinner'];
const MAIN_MEAL_TYPES = ['breakfast', 'lunch', 'dinner'];
const NUTRIENTS = ['calories', 'protein', 'fat', 'carbs'];

function validateGoals(goals) {
    return goals && NUTRIENTS.every(nutrient =>
        typeof goals[nutrient] === 'number' &&
        Number.isFinite(goals[nutrient]) &&
        goals[nutrient] > 0
    );
}

function buildPlan(candidate, index, dishesById, goals, tolerancePercent) {
    if (!candidate || typeof candidate !== 'object' ||
        !candidate.meals || typeof candidate.meals !== 'object') {
        return null;
    }

    const meals = {};
    const totals = {
        calories: 0,
        protein: 0,
        fat: 0,
        carbs: 0,
        portion_weight_g: 0
    };

    for (const mealType of MEAL_TYPES) {
        const entries = candidate.meals[mealType];

        if (mealType === 'snack' && entries === undefined) {
            meals[mealType] = [];
            continue;
        }

        if (!Array.isArray(entries)) {
            return null;
        }

        const seenDishIds = new Set();
        meals[mealType] = [];

        for (const entry of entries) {
            if (
                !entry ||
                !Number.isInteger(entry.dish_id) ||
                ![1, 2].includes(entry.servings) ||
                seenDishIds.has(entry.dish_id)
            ) {
                return null;
            }

            const dish = dishesById.get(entry.dish_id);

            if (!dish) {
                return null;
            }

            seenDishIds.add(entry.dish_id);

            const plannedDish = {
                dish_id: dish.id,
                name: dish.name,
                servings: entry.servings
            };

            for (const nutrient of NUTRIENTS) {
                plannedDish[nutrient] = dish[nutrient] * entry.servings;
                totals[nutrient] += plannedDish[nutrient];
            }

            plannedDish.portion_weight_g =
                dish.portion_weight_g * entry.servings;
            totals.portion_weight_g += plannedDish.portion_weight_g;
            meals[mealType].push(plannedDish);
        }
    }

    if (MAIN_MEAL_TYPES.some(mealType => meals[mealType].length === 0)) {
        return null;
    }

    const deviations = {};
    let score = 0;
    let withinTolerance = true;

    for (const nutrient of NUTRIENTS) {
        const difference = totals[nutrient] - goals[nutrient];
        const percent = difference / goals[nutrient] * 100;
        deviations[nutrient] = {
            target: goals[nutrient],
            difference,
            percent
        };
        score += Math.abs(percent);
        withinTolerance &&= Math.abs(percent) <= tolerancePercent;
    }

    return {
        title: typeof candidate.title === 'string' && candidate.title.trim()
            ? candidate.title.trim().slice(0, 80)
            : `Вариант ${index + 1}`,
        meals,
        totals,
        deviations,
        within_tolerance: withinTolerance,
        score
    };
}

function validateMealPlans(
    candidates,
    dishes,
    goals,
    count = 3,
    tolerancePercent = 15
) {
    if (!validateGoals(goals)) {
        throw new Error('Для составления плана нужны дневные цели по КБЖУ.');
    }

    if (!Array.isArray(candidates)) {
        const error = new Error('Gemini вернул неверный формат плана питания.');
        error.statusCode = 502;
        throw error;
    }

    const dishesById = new Map(dishes.map(dish => [dish.id, dish]));
    const plans = candidates
        .map((candidate, index) =>
            buildPlan(candidate, index, dishesById, goals, tolerancePercent)
        )
        .filter(Boolean)
        .sort((first, second) => first.score - second.score)
        .slice(0, count)
        .map(({ score, ...plan }, index) => ({
            ...plan,
            id: index + 1
        }));

    if (plans.length === 0) {
        const error = new Error(
            'Gemini не вернул корректных вариантов из выбранных блюд. Попробуйте ещё раз.'
        );
        error.statusCode = 502;
        throw error;
    }

    return plans;
}

function createPrompt(menus, goals, count, tolerancePercent) {
    return `Ты составляешь дневной план питания только из блюд переданных меню.

Цели на день:
${JSON.stringify(goals)}

Нужно вернуть до ${count} разных вариантов. Старайся, чтобы калории, белки,
жиры и углеводы каждого варианта отличались от целей не более чем на
${tolerancePercent}%. Если это невозможно, верни наиболее близкие варианты.

Используй только dish_id из списка. Не придумывай блюда и не меняй значения
питательности. Для каждого блюда укажи 1 или 2 порции. Не повторяй одно блюдо
внутри одного приёма пищи. Завтрак, обед и ужин должны содержать хотя бы одно
блюдо; перекус может быть пустым. Не обязательно использовать каждое блюдо.

Меню и блюда (питательность указана на одну порцию):
${JSON.stringify(menus)}

Верни только JSON формата:
{
  "plans": [
    {
      "title": "Краткое название варианта",
      "meals": {
        "breakfast": [{"dish_id": 1, "servings": 1}],
        "lunch": [{"dish_id": 2, "servings": 1}],
        "snack": [],
        "dinner": [{"dish_id": 3, "servings": 2}]
      }
    }
  ]
}
Не включай расчёты в ответ: итоги и отклонения будут рассчитаны приложением.`;
}

async function generateMealPlans({
    menus,
    dishes,
    goals,
    count = 3,
    tolerancePercent = 15
}) {
    if (!process.env.GEMINI_API_KEY) {
        throw new Error('Не задан GEMINI_API_KEY в файле .env');
    }

    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const model = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
    const response = await ai.models.generateContent({
        model,
        contents: createPrompt(menus, goals, count, tolerancePercent),
        config: {
            responseMimeType: 'application/json',
            temperature: 0
        }
    });

    if (!response.text) {
        throw new Error('Gemini вернул пустой ответ для плана питания.');
    }

    let result;

    try {
        result = JSON.parse(response.text);
    } catch {
        const error = new Error('Не удалось разобрать ответ Gemini с планом питания.');
        error.statusCode = 502;
        throw error;
    }

    return validateMealPlans(
        result?.plans,
        dishes,
        goals,
        count,
        tolerancePercent
    );
}

module.exports = { generateMealPlans, validateMealPlans };
