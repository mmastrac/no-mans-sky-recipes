const cheerio = require('cheerio');
const fs = require('fs');
const util = require('util');
const readdir = util.promisify(fs.readdir);
const readFile = util.promisify(fs.readFile);

function extractValue($, name) {
    return $.find(`Property[name="${name}"]`).attr("value");
}

function extractChildren($, name) {
    return $.find(`Property[name="${name}"]`);
}

function extractIngredient($) {
    const type = extractValue(extractChildren($, "Type"), "InventoryType");
    return {
        id: [type, extractValue($, "Id")],
        amount: extractValue($, "Amount"),
    };
}

function extractIngredientTech($) {
    const type = extractValue(extractChildren($, "InventoryType"), "InventoryType");
    return {
        id: [type, extractValue($, "ID")],
        amount: extractValue($, "Amount"),
    };
}

function extractColor($) {
    const color = extractChildren($, "Colour");
    const r = +extractValue(color, "R");
    const g = +extractValue(color, "G");
    const b = +extractValue(color, "B");
    return [r, g, b];
}

function processText($, o) {
    const id = extractValue($, "Id");
    o[id] = $.find('Property[name="USEnglish"]').find('Property').attr('value').trim();
}

function processRecipe($, o) {
    const id = extractValue($, "Id");
    // if (extractValue($, "Cooking") == "False") {
        let result = extractIngredient(extractChildren($, "Result"));
        let ingredients = Array.from(extractChildren($, "Ingredients").children().map((_, child) => {
            child = $.find(child);
            return extractIngredient(child);
        }));
        o[id] = {
            name: extractValue($, "Name"),
            time: +extractValue($, "TimeToMake"),
            ingredients: ingredients,
            result: result
        };
    //}
}

function processTech($, o) {
    const id = extractValue($, "ID");
    const color = extractColor($, "Colour");
    let ingredients = Array.from(extractChildren($, "Requirements").children().map((_, child) => {
        child = $.find(child);
        return extractIngredientTech(child);
    }));
    o[id] = {
        name: extractValue($, "NameLower"),
        color: color,
        ingredients: ingredients,
        result: {
            id: ["Tech", id],
            amount: 1},
    };
}

function processSubstance($, o) {
    const id = extractValue($, "ID");
    const color = extractColor($, "Colour");
    o[id] = {
        name: extractValue($, "NameLower"),
        color: color,
    };
}

function processProduct($, o) {
    const id = extractValue($, "Id");
    const color = extractColor($, "Colour");
    let ingredients = Array.from(extractChildren($, "Requirements").children().map((_, child) => {
        child = $.find(child);
        return extractIngredientTech(child);
    }));
    o[id] = {
        name: extractValue($, "NameLower"),
        color: color,
        ingredients: ingredients,
        result: {
            id: ["Product", id],
            amount: 1},
    };
}


async function loadTables(dir) {
    const objects = {
        "TkLocalisationEntry.xml": { f: processText, o: {} },
        "GcRefinerRecipe.xml": { f: processRecipe, o: {} },
        "GcRealitySubstanceData.xml": { f: processSubstance, o: {} },
        "GcProductData.xml": { f: processProduct, o: {} },
        "GcTechnology.xml": {f: processTech, o: {} },
    };
    const names = (await readdir(dir)).filter((f) => {
        if (f.toLowerCase().endsWith(".exml")) {
            return true;
        }
    });
    const tables = names.map(async (name) => {
        const xml = await readFile(dir + "/" + name);
        const $ = cheerio.load(xml, { xmlMode: true });
        const children = $.root().children().children().children();
        children.each((_, child) => {
            child = $(child);
            const value = child.attr('value');
            objects[value].f(child, objects[value].o);
        });
        console.error("Processed", children.length, "entries from", name);
        return objects;
    });
    await Promise.all(tables);

    const rawRecipes = Object.assign(objects["GcRefinerRecipe.xml"].o, objects["GcTechnology.xml"].o, objects["GcProductData.xml"].o)
    const strings = objects["TkLocalisationEntry.xml"].o;
    const substances = {
        "Substance": objects["GcRealitySubstanceData.xml"].o,
        "Product": objects["GcProductData.xml"].o,
        "Tech": objects["GcTechnology.xml"].o,
    }
    const recipes = [];
    
    function mapIngredient(ingredient) {
        const substance = substances[ingredient.id[0]][ingredient.id[1]];
        if (!substance) {
            ingredient.id = "Unknown: " + ingredient.id;
            return;
        }
        ingredient.id = strings[substance.name] || ("Not found: " + substance.name);
        ingredient.color = substance.color;
    }

    for (var x in rawRecipes) {
        const recipe = rawRecipes[x];
        mapIngredient(recipe.result);
        recipe.ingredients.forEach(ingredient => {
            mapIngredient(ingredient);
        });
        recipe.name = strings[recipe.name];
        if (recipe.name == undefined) {
            recipe.name = "Unknown: " + recipe["result"].id
        }
        recipe.name = recipe.name.replace("Requested Operation: ", "");
        recipes.push(recipe);
    }

    recipes.sort((a, b) => {
        return a.name.localeCompare(b.name);
    });

    return recipes;
}

function writeText(recipes) {
    function stringifyIngredient(i) {
        return i.id + " (" + i.amount + ")";
    }
    const table = recipes.map(recipe => {
        return stringifyIngredient(recipe.result) + " <- " + recipe.ingredients.map(stringifyIngredient).join(' + ') + "\t" + "[" + recipe.name + "]";
    });
    table.sort();
    fs.writeFileSync("docs/recipes.txt", table.join('\n'));
}

function writeHtml(recipes) {
    const $ = cheerio.load("<html><head /><body /></html>");
    const head = $('head');
    head.append($('<title>').text("Recipes"));
    head.append($('<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@500&display=swap" rel="stylesheet">'));
    head.append($('<style>html { background-color: white; } * { font-family: "Heebo", sans-serif; }</style>'));
    const body = $('body');
    $('<h1>').text("No Man's Sky Recipes").appendTo(body);
    const table = $('<table>').appendTo(body);

    function stringifyIngredient(i) {
        return i.id + " (" + i.amount + ")";
    }

    recipes.sort((a, b) => {
        if (a.result.id == b.result.id) {
            if (a.ingredient && b.ingredient){
                if (a.ingredients.length == b.ingredients.length) {
                    if (a.result.amount == b.result.amount) {
                        return a.ingredients[0].id.localeCompare(b.ingredients[0].id);
                    }
                    return a.result.amount - b.result.amount;
                }
            }
            return a.ingredients.length - b.ingredients.length;
        }
        return a.result.id.localeCompare(b.result.id);
    });

    recipes.forEach(recipe => {
        const tr = $('<tr>').appendTo(table);
        const [r, g, b] = recipe.result.color;
        const color = `rgba(${r*255}, ${g*255}, ${b*255}, 1.0)`
        // 0.2126 × Rγ + 0.7152 × Gγ + 0.0722 × Bγ > 0.5γ
        const gamma = 2.2;
        const white = 0.2126 * Math.pow(r, gamma) + 0.7152 * Math.pow(g, gamma) + 0.0722 * Math.pow(b, gamma) < Math.pow(0.5, gamma);
        $('<td>').appendTo(tr).text(stringifyIngredient(recipe.result)).attr('style', `color: ${white ? 'white' : 'black'}; background-color: ${color}`);
        $('<td>').appendTo(tr).text("←");
        recipe.ingredients.forEach((i, idx) => {
            if (idx) {
                $('<td>').appendTo(tr).text("+");
            }
            $('<td>').appendTo(tr).text(stringifyIngredient(i));
        });
    });

    $('<a>').attr('href', 'https://github.com/mmastrac/no-mans-sky-recipes/').text("Source").appendTo(body);

    fs.writeFileSync("docs/index.html", $.html());
}

async function go() {
    const recipes = await loadTables(process.argv[2]);

    console.error("Wrote docs/recipes.json");
    fs.writeFileSync("docs/recipes.json", JSON.stringify(recipes, null, 2));

    writeText(recipes);
    console.error("Wrote docs/recipes.txt");

    writeHtml(recipes);
    console.error("Wrote docs/index.html");
}

go();
