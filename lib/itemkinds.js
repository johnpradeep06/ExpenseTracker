'use strict';
// A starting guess for whether one item on a bill is necessary ('need') or unnecessary ('fun'), from its name alone:
// French first, English too, accents ignored. This is only a first guess. The person's own earlier choices about the
// same product, and their taps, always win (see lib/bills.js). Anything not on these lists stays 'unk' (not sure).
const fold = (s) => String(s === undefined || s === null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Words are matched at the start of a word, so "croustilles" also catches "croustille". Add ! for the whole word only.
const FUN = ('croustille chips doritos cheetos pringles ruffles popcorn mais_souffle bretzel pretzel bonbon candy gomme chocolat chocolate caramel guimauve ' +
  'biscuit cookie oreo gateau muffin beignet donut patisserie dessert tarte! brownie creme_glacee glace! gelato sorbet popsicle ' +
  'coca pepsi soda boisson_gazeuse limonade! sprite fanta ginger_ale! mountain_dew red_bull monster energie energy gatorade kombucha ' +
  'biere beer vin! vins wine vodka whisky rhum gin! cidre champagne alcool liqueur seltzer cooler ' +
  'cigarette tabac vape poutine burger frites! nugget pizza! hot_dog! sushi').split(' ');
const NEED = ('lait! milk oeuf egg beurre! margarine fromage! yogourt yogurt pain! bagel! tortilla farine sucre! sel! poivre huile vinaigre ' +
  'poulet boeuf porc dinde jambon! saucisse! bacon! viande poisson saumon thon! crevette tofu lentille! pois! haricot feve ' +
  'riz! pate! pates spaghetti macaroni nouille quinoa couscous avoine cereale ' +
  'legume fruit pomme! banane orange! citron! raisin! fraise! bleuet framboise melon! avocat! tomate concombre laitue salade! epinard brocoli chou! carotte celeri oignon ail! patate pomme_de_terre poivron courge champignon ' +
  'conserve! soupe! sauce! pate_de_tomate eau! water cafe! the! tisane ' +
  'savon shampoing! shampoo revitalisant dentifrice brosse_a_dents deodorant papier_de_toilette papier_toilette papier_hygienique essuie_tout mouchoir couche! detergent javel! nettoyant eponge sac_poubelle ' +
  'medicament acetaminophene ibuprofene vitamine pansement! tampon rasoir!').split(' ');

const compile = (words) => words.filter(Boolean).map((w) => {
  const whole = w.slice(-1) === '!';
  const t = (whole ? w.slice(0, -1) : w).replace(/_/g, ' ');
  return new RegExp('(^| )' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + (whole ? '( |$)' : ''));
});
const FUN_RE = compile(FUN);
const NEED_RE = compile(NEED);

// 'fun' | 'need' | 'unk'. An unnecessary word wins when both appear ("lait au chocolat", "pate de croissant").
const kindOfItem = (name) => {
  const t = ' ' + fold(name).replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const f = t.trim();
  if (FUN_RE.some((re) => re.test(f))) return 'fun';
  if (NEED_RE.some((re) => re.test(f))) return 'need';
  return 'unk';
};

module.exports = { kindOfItem };
