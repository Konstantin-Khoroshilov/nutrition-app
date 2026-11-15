const test = require('node:test');
const assert = require('node:assert/strict');
const { validateMealPlans } = require('./mealPlanner');

const dishes = [
    {
        id: 1,
        name: 'Овсяная каша',
        portion_weight_g: 200,
        calories: 300,
        protein: 10,
        fat: 6,
        carbs: 50
    },
    {
        id: 2,
        name: 'Курица с рисом',
        portion_weight_g: 350,
        calories: 500,
        protein: 45,
        fat: 12,
        carbs: 50
    },
    {
        id: 3,
        name: 'Яблоко',
        portion_weight_g: 150,
        calories: 100,
        protein: 0.5,
        fat: 0.3,
        carbs: 25
    },
    {
        id: 4,
        name: 'Рыба с овощами',
        portion_weight_g: 300,
        calories: 600,
        protein: 40,
        fat: 25,
        carbs: 0
    }
];

const goals = {
    calories: 1500,
    protein: 95.5,
    fat: 43.3,
    carbs: 125
};

function createCandidate() {
    return {
        title: 'Сбалансированный вариант',
        meals: {
            breakfast: [{ dish_id: 1, servings: 2 }],
            lunch: [{ dish_id: 2, servings: 1 }],
            snack: [{ dish_id: 3, servings: 1 }],
            dinner: [{ dish_id: 4, servings: 1 }]
        }
    };
}

test('calculates totals and deviations using one- and two-portion dishes', () => {
    const [plan] = validateMealPlans(
        [createCandidate()],
        dishes,
        goals
    );

    assert.equal(plan.meals.breakfast[0].servings, 2);
    assert.equal(plan.meals.breakfast[0].portion_weight_g, 400);
    assert.equal(plan.meals.breakfast[0].calories, 600);
    assert.equal(plan.totals.calories, 1800);
    assert.equal(plan.deviations.calories.percent, 20);
    assert.equal(plan.within_tolerance, false);
});

test('discards plans that select unknown dishes or unsupported serving counts', () => {
    const invalidDish = createCandidate();
    invalidDish.meals.lunch[0].dish_id = 999;

    const invalidServings = createCandidate();
    invalidServings.meals.breakfast[0].servings = 3;

    const plans = validateMealPlans(
        [invalidDish, invalidServings, createCandidate()],
        dishes,
        goals
    );

    assert.equal(plans.length, 1);
    assert.equal(plans[0].title, 'Сбалансированный вариант');
});

test('allows an omitted snack when the three main meals are present', () => {
    const candidate = createCandidate();
    delete candidate.meals.snack;

    const [plan] = validateMealPlans([candidate], dishes, goals);

    assert.deepEqual(plan.meals.snack, []);
});

test('fails explicitly when Gemini returns no usable plan', () => {
    assert.throws(
        () => validateMealPlans([], dishes, goals),
        error => error.statusCode === 502
    );
});
