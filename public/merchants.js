/* Merchant pipeline: turns the raw store text a card gives ("Saq23028faubourg Ste-Cat", "TIM HORTONS #4567 MONTREAL QC")
   into a clean name and, when the store is known, a category. Rules only: no network, no model, instant, and the same
   answer in the app and on the server (the server loads this file too, so alerts agree with the screens).

   Order of work for one string:
     1. Known stores (a list, mostly Montreal and Quebec): the brand's real name and category.
     2. Store-type words, English and French ("marché", "boulangerie", "pharmacie"...): a category, with the name tidied.
     3. Anything else: the name is tidied (store numbers, branch codes, city and province removed) and left uncategorized,
        so the app's other rules and the Shortcut's own category can still be used.
   Never invents anything: an unknown store keeps its own words. */
(function () {
  const CATS = ['Groceries', 'Dining & Coffee', 'Food Delivery', 'Snacks', 'Transport', 'Subscriptions & Software', 'Shopping', 'Entertainment', 'Health & Personal Care', 'Bills & Utilities', 'Travel'];

  // "Name|Category|pattern;pattern;..." Patterns are written without accents or punctuation. A pattern matches from the start
  // of a word; add ! to make it match the whole word only. Name * means "keep the tidied name, only set the category".
  const BRANDS = [
    // --- liquor ---
    'SAQ|Entertainment|saq!;saq express;saq selection;saq depot;societe des alcools',
    'LCBO|Entertainment|lcbo;the beer store;beer store;wine rack;vintages',
    // --- groceries ---
    'Metro|Groceries|metro!;metro plus;metro etc;metro inc',
    'Super C|Groceries|super c!',
    'Maxi|Groceries|maxi!;maxi & cie;maxi et cie',
    'Provigo|Groceries|provigo',
    'Loblaws|Groceries|loblaw',
    'IGA|Groceries|iga!;iga extra;iga express',
    'Adonis|Groceries|adonis',
    'Marché Tradition|Groceries|marche tradition',
    'Marché Richelieu|Groceries|marche richelieu',
    'Marché 440|Groceries|marche 440',
    'Marché Jean-Talon|Groceries|marche jean talon',
    'Marché Atwater|Groceries|marche atwater',
    'Marché Akhavan|Groceries|marche akhavan',
    'Intermarché|Groceries|intermarche',
    'Bonichoix|Groceries|bonichoix',
    'Avril|Groceries|avril supermarche;avril sante',
    'Rachelle-Béry|Groceries|rachelle bery',
    'Costco Gas|Transport|costco gas;costco essence;costco wholesale gas',
    'Costco|Groceries|costco',
    'Walmart|Groceries|walmart supercentre;walmart super centre',
    'Walmart|Shopping|walmart;wal mart',
    'Food Basics|Groceries|food basics',
    'No Frills|Groceries|no frills;nofrills',
    'Sobeys|Groceries|sobeys',
    'FreshCo|Groceries|freshco',
    'Farm Boy|Groceries|farm boy',
    'T&T Supermarket|Groceries|t&t!',
    'Whole Foods|Groceries|whole foods',
    "Longo's|Groceries|longos",
    'Instacart|Groceries|instacart',
    'Bulk Barn|Groceries|bulk barn',
    'Giant Tiger|Shopping|giant tiger;tigre geant',
    'Dollar Tree|Shopping|dollar tree',
    // --- food delivery (before Uber and Skip) ---
    'Uber Eats|Food Delivery|uber eats;ubereats',
    'DoorDash|Food Delivery|doordash;door dash',
    'SkipTheDishes|Food Delivery|skipthedishes;skip the dishes;skip dishes',
    'Foodora|Food Delivery|foodora',
    'Fantuan|Food Delivery|fantuan',
    'HungryPanda|Food Delivery|hungrypanda;hungry panda',
    'Just Eat|Food Delivery|just eat;justeat',
    'Menu.ca|Food Delivery|menu ca',
    // --- dining and coffee ---
    'Tim Hortons|Dining & Coffee|tim hortons;timhortons;tim horton;tims!',
    'Starbucks|Dining & Coffee|starbucks',
    'Second Cup|Dining & Coffee|second cup',
    'Van Houtte|Dining & Coffee|van houtte',
    "Dunkin'|Dining & Coffee|dunkin",
    'Première Moisson|Dining & Coffee|premiere moisson',
    'Café Depot|Dining & Coffee|cafe depot',
    'Café Olimpico|Dining & Coffee|olimpico',
    'Cacao 70|Dining & Coffee|cacao 70',
    'Juliette & Chocolat|Dining & Coffee|juliette et chocolat;juliette & chocolat',
    'St-Hubert|Dining & Coffee|st hubert;saint hubert;sthubert',
    'Scores|Dining & Coffee|scores!',
    'Poulet Rouge|Dining & Coffee|poulet rouge',
    "Mike's|Dining & Coffee|mikes!;mikes restaurant",
    'Pacini|Dining & Coffee|pacini',
    'Baton Rouge|Dining & Coffee|baton rouge',
    'Chez Cora|Dining & Coffee|chez cora;cora!',
    'Eggspectation|Dining & Coffee|eggspectation',
    'La Belle Province|Dining & Coffee|la belle province;belle province',
    'Burger King|Dining & Coffee|burger king',
    "McDonald's|Dining & Coffee|mcdonald;mcdo!",
    "Wendy's|Dining & Coffee|wendys;wendy!",
    'A&W|Dining & Coffee|a&w!;a and w',
    "Harvey's|Dining & Coffee|harveys;harvey!",
    'Subway|Dining & Coffee|subway!',
    'KFC|Dining & Coffee|kfc;kentucky fried',
    'Popeyes|Dining & Coffee|popeyes',
    "Mary Brown's|Dining & Coffee|mary browns",
    'Chipotle|Dining & Coffee|chipotle',
    'Taco Bell|Dining & Coffee|taco bell',
    'Pizza Hut|Dining & Coffee|pizza hut',
    "Domino's|Dining & Coffee|dominos;domino!",
    'Pizza Pizza|Dining & Coffee|pizza pizza',
    "Little Caesars|Dining & Coffee|little caesars",
    'Pizza Salvatoré|Dining & Coffee|pizza salvatore',
    'Amir|Dining & Coffee|amir!',
    'Basha|Dining & Coffee|basha!',
    'Boustan|Dining & Coffee|boustan',
    "Schwartz's|Dining & Coffee|schwartz",
    'St-Viateur Bagel|Dining & Coffee|st viateur bagel;saint viateur bagel',
    'Fairmount Bagel|Dining & Coffee|fairmount bagel',
    "Reuben's|Dining & Coffee|reubens",
    "Nando's|Dining & Coffee|nandos",
    'Thai Express|Dining & Coffee|thai express',
    'Freshii|Dining & Coffee|freshii',
    'Panera|Dining & Coffee|panera',
    'Sushi Shop|Dining & Coffee|sushi shop',
    'Sushi Taxi|Dining & Coffee|sushi taxi',
    'Kinka Izakaya|Dining & Coffee|kinka',
    'Chatime|Dining & Coffee|chatime',
    'Gong Cha|Dining & Coffee|gong cha',
    'Tiger Sugar|Dining & Coffee|tiger sugar',
    'Sharetea|Dining & Coffee|sharetea',
    'Presotea|Dining & Coffee|presotea',
    "Yogurty's|Dining & Coffee|yogurtys",
    "Menchie's|Dining & Coffee|menchies",
    'Lola Rosa|Dining & Coffee|lola rosa',
    'Copper Branch|Dining & Coffee|copper branch',
    'La Banquise|Dining & Coffee|la banquise',
    'Smoke Meat Pete|Dining & Coffee|smoke meat pete',
    // --- snacks ---
    'Couche-Tard|Snacks|couche tard;couchetard',
    '7-Eleven|Snacks|7 eleven;7eleven',
    'Provi-Soir|Snacks|provi soir;provisoir',
    // --- transport ---
    'STM|Transport|stm!;opus!;societe de transport de montreal',
    'RTC|Transport|rtc!;reseau de transport de la capitale',
    'exo|Transport|exo!',
    'BIXI|Transport|bixi',
    'Communauto|Transport|communauto',
    'Zipcar|Transport|zipcar',
    'Uber|Transport|uber!;ubertrip',
    'Lyft|Transport|lyft',
    'Petro-Canada|Transport|petro canada;petro can;petrocanada',
    'Ultramar|Transport|ultramar',
    'Esso|Transport|esso!',
    'Shell|Transport|shell!',
    'Irving|Transport|irving',
    'Harnois|Transport|harnois',
    'Pioneer|Transport|pioneer!',
    'Impark|Transport|impark',
    'Indigo Parking|Transport|indigo parc;indigo parking',
    'Green P|Transport|green p!',
    'Agence de mobilité durable|Transport|agence de mobilite durable;agence mobilite durable',
    '407 ETR|Transport|407 etr',
    'Jiffy Lube|Transport|jiffy lube',
    'Midas|Transport|midas!',
    'Mr. Lube|Transport|mr lube',
    'Kal Tire|Transport|kal tire',
    'Monsieur Muffler|Transport|monsieur muffler',
    // --- travel ---
    'Air Canada|Travel|air canada',
    'Air Transat|Travel|air transat;transat!',
    'Porter|Travel|porter airlines;porter!',
    'WestJet|Travel|westjet',
    'Flair Airlines|Travel|flair air',
    'Via Rail|Travel|via rail',
    'Orléans Express|Travel|orleans express',
    'Megabus|Travel|megabus',
    'FlixBus|Travel|flixbus',
    'Airbnb|Travel|airbnb',
    'Booking.com|Travel|booking com;booking!',
    'Expedia|Travel|expedia',
    'Aéroports de Montréal|Travel|aeroports de montreal;adm aeroports',
    // --- subscriptions and software ---
    'Netflix|Subscriptions & Software|netflix',
    'Spotify|Subscriptions & Software|spotify',
    'Apple|Subscriptions & Software|apple com bill;apple services;itunes;apple one',
    'iCloud|Subscriptions & Software|icloud',
    'YouTube|Subscriptions & Software|youtube',
    'Disney+|Subscriptions & Software|disney plus;disneyplus;disney!',
    'Prime Video|Subscriptions & Software|prime video;amazon prime;amazon ca prime;amzn prime',
    'OpenAI|Subscriptions & Software|openai;chatgpt',
    'Anthropic|Subscriptions & Software|anthropic',
    'GitHub|Subscriptions & Software|github',
    'Adobe|Subscriptions & Software|adobe',
    'Microsoft|Subscriptions & Software|microsoft;msft',
    'Dropbox|Subscriptions & Software|dropbox',
    'Notion|Subscriptions & Software|notion!',
    'Figma|Subscriptions & Software|figma',
    'Canva|Subscriptions & Software|canva',
    'Vercel|Subscriptions & Software|vercel',
    'Railway|Subscriptions & Software|railway!',
    'Crave|Subscriptions & Software|crave!',
    'Club illico|Subscriptions & Software|club illico;illico!',
    'ICI TOU.TV|Subscriptions & Software|tou tv;toutv',
    'Noovo|Subscriptions & Software|noovo',
    'Paramount+|Subscriptions & Software|paramount',
    'Audible|Subscriptions & Software|audible',
    'Google One|Subscriptions & Software|google one;google storage',
    'Google Play|Subscriptions & Software|google play',
    'Patreon|Subscriptions & Software|patreon',
    'Substack|Subscriptions & Software|substack',
    'Cursor|Subscriptions & Software|cursor!',
    'Perplexity|Subscriptions & Software|perplexity',
    'LinkedIn|Subscriptions & Software|linkedin',
    // --- shopping ---
    'Amazon|Shopping|amazon;amzn',
    'Dollarama|Shopping|dollarama',
    'Renaud-Bray|Shopping|renaud bray',
    'Archambault|Shopping|archambault',
    'Simons|Shopping|simons!;maison simons',
    "La Baie d'Hudson|Shopping|la baie;hudsons bay;the bay!",
    'Canadian Tire|Shopping|canadian tire;can tire',
    'Rona|Shopping|rona!',
    'Réno-Dépôt|Shopping|reno depot',
    'BMR|Shopping|bmr!',
    'Home Depot|Shopping|home depot;homedepot',
    'IKEA|Shopping|ikea',
    'Winners|Shopping|winners;marshalls;homesense',
    'Best Buy|Shopping|best buy;bestbuy',
    'Apple Store|Shopping|apple store;apple retail',
    'Staples|Shopping|staples;bureau en gros',
    'Indigo|Shopping|indigo!;chapters;indigo books',
    'Michaels|Shopping|michaels!',
    'Jysk|Shopping|jysk',
    'Structube|Shopping|structube',
    'EQ3|Shopping|eq3',
    'Le Brick|Shopping|brick!;le brick',
    'Décathlon|Shopping|decathlon',
    'Sports Experts|Shopping|sports experts',
    'MEC|Shopping|mountain equipment;mec!',
    'Lululemon|Shopping|lululemon',
    'Aritzia|Shopping|aritzia',
    'Zara|Shopping|zara!',
    'H&M|Shopping|h&m!;h & m',
    'Uniqlo|Shopping|uniqlo',
    'Old Navy|Shopping|old navy',
    'Gap|Shopping|gap!',
    'American Eagle|Shopping|american eagle',
    'Roots|Shopping|roots!',
    'Reitmans|Shopping|reitmans',
    'Ardene|Shopping|ardene',
    'La Vie en Rose|Shopping|la vie en rose',
    'Le Château|Shopping|le chateau',
    'Aldo|Shopping|aldo!',
    'Nike|Shopping|nike!',
    'Adidas|Shopping|adidas',
    'SHEIN|Shopping|shein',
    'Temu|Shopping|temu',
    'Etsy|Shopping|etsy',
    'eBay|Shopping|ebay',
    'AliExpress|Shopping|aliexpress',
    // --- health and personal care ---
    'Jean Coutu|Health & Personal Care|jean coutu',
    'Pharmaprix|Health & Personal Care|pharmaprix;shoppers drug mart;shoppers!',
    'Uniprix|Health & Personal Care|uniprix',
    'Familiprix|Health & Personal Care|familiprix',
    'Brunet|Health & Personal Care|brunet!',
    'Proxim|Health & Personal Care|proxim!',
    'Pharmachoix|Health & Personal Care|pharmachoix',
    'Rexall|Health & Personal Care|rexall',
    'London Drugs|Health & Personal Care|london drugs',
    'Sephora|Health & Personal Care|sephora',
    'GoodLife Fitness|Health & Personal Care|goodlife',
    'Econofitness|Health & Personal Care|econofitness;econo fitness',
    'Jetfit|Health & Personal Care|jetfit',
    'Énergie Cardio|Health & Personal Care|energie cardio',
    'YMCA|Health & Personal Care|ymca!',
    'Planet Fitness|Health & Personal Care|planet fitness',
    'Dynacare|Health & Personal Care|dynacare',
    'Biron|Health & Personal Care|biron!',
    // --- bills and utilities ---
    'Hydro-Québec|Bills & Utilities|hydro quebec;hydroquebec',
    'Énergir|Bills & Utilities|energir;gaz metro',
    'Vidéotron|Bills & Utilities|videotron',
    'Bell|Bills & Utilities|bell!;bell canada;bell mobilite',
    'Rogers|Bills & Utilities|rogers',
    'Telus|Bills & Utilities|telus',
    'Fido|Bills & Utilities|fido!',
    'Koodo|Bills & Utilities|koodo',
    'Virgin Plus|Bills & Utilities|virgin plus;virgin mobile',
    'Freedom Mobile|Bills & Utilities|freedom mobile',
    'Fizz|Bills & Utilities|fizz!',
    'Public Mobile|Bills & Utilities|public mobile',
    'Chatr|Bills & Utilities|chatr',
    'Lucky Mobile|Bills & Utilities|lucky mobile',
    'Cogeco|Bills & Utilities|cogeco',
    'Distributel|Bills & Utilities|distributel',
    'TekSavvy|Bills & Utilities|teksavvy',
    'Desjardins Assurances|Bills & Utilities|desjardins assurance',
    'Intact Assurance|Bills & Utilities|intact assurance',
    'belairdirect|Bills & Utilities|belairdirect',
    'La Capitale|Bills & Utilities|la capitale',
    'Sun Life|Bills & Utilities|sun life',
    'SAAQ|Bills & Utilities|saaq!;societe de l assurance automobile',
    'Revenu Québec|Bills & Utilities|revenu quebec',
    'Services Québec|Bills & Utilities|services quebec',
    'Ville de Montréal|Bills & Utilities|ville de montreal',
    'Canada Revenue Agency|Bills & Utilities|canada revenue;cra!',
    // --- entertainment ---
    'Cineplex|Entertainment|cineplex',
    'Cinéma du Parc|Entertainment|cinema du parc',
    'Cinéma Beaubien|Entertainment|cinema beaubien',
    'Cinémas Guzzo|Entertainment|guzzo',
    'Cinéma Starcité|Entertainment|starcite',
    'Centre Bell|Entertainment|centre bell',
    'Place des Arts|Entertainment|place des arts',
    'Ticketmaster|Entertainment|ticketmaster',
    'evenko|Entertainment|evenko',
    'Eventbrite|Entertainment|eventbrite',
    'Laser Quest|Entertainment|laser quest',
    'Biodôme|Entertainment|biodome',
    'Planétarium|Entertainment|planetarium',
    'Loto-Québec|Entertainment|loto quebec;lotoquebec',
    'Casino de Montréal|Entertainment|casino de montreal',
    'Steam|Entertainment|steam!;steam games',
    'PlayStation|Entertainment|playstation',
    'Xbox|Entertainment|xbox',
    'Nintendo|Entertainment|nintendo',
    'Twitch|Entertainment|twitch',
    // --- more Montreal and Quebec: groceries ---
    'Marché Maisonneuve|Groceries|marche maisonneuve',
    'Marché Newon|Groceries|marche newon',
    'Marché Tau|Groceries|marche tau',
    'PA Supermarché|Groceries|pa supermarche;marche pa!',
    'Kim Phat|Groceries|kim phat',
    "Segal's Market|Groceries|segals",
    'Fromagerie Hamel|Groceries|fromagerie hamel',
    'Goodfood|Groceries|goodfood;good food',
    'HelloFresh|Groceries|hellofresh;hello fresh',
    'Romados|Dining & Coffee|romados',
    // --- dining and coffee ---
    'Bar Burrito|Dining & Coffee|bar burrito',
    'Madisons|Dining & Coffee|madisons',
    'Paillard|Dining & Coffee|paillard',
    'Orange Julep|Dining & Coffee|orange julep',
    'Chalet Bar-B-Q|Dining & Coffee|chalet bar b q;chalet bbq;chalet barbq',
    'La Cage|Dining & Coffee|cage aux sports;la cage brasserie',
    'Benny & Co.|Dining & Coffee|benny & co;benny et co;benny co',
    'Le Pain Quotidien|Dining & Coffee|pain quotidien',
    'Presse Café|Dining & Coffee|presse cafe',
    'Frite Alors|Dining & Coffee|frite alors',
    "Lester's|Dining & Coffee|lesters",
    'Wilensky|Dining & Coffee|wilensky',
    'Dispatch Coffee|Dining & Coffee|dispatch coffee',
    'Pikolo|Dining & Coffee|pikolo',
    'Crudessence|Dining & Coffee|crudessence',
    'Poulet Frit Kentucky|Dining & Coffee|poulet frit kentucky',
    'Pizza Delight|Dining & Coffee|pizza delight',
    'Pizzaiolle|Dining & Coffee|pizzaiolle',
    'Dairy Queen|Snacks|dairy queen',
    'Cinnabon|Snacks|cinnabon',
    'Baskin-Robbins|Snacks|baskin',
    // --- transport ---
    'Circle K|Transport|circle k',
    'Canadian Tire Gas+|Transport|canadian tire gas',
    'Taxi Diamond|Transport|taxi diamond',
    'PayByPhone|Transport|paybyphone',
    'CAA-Québec|Transport|caa quebec',
    // --- health, optical, gyms, spas ---
    'New Look|Health & Personal Care|new look',
    'Greiche & Scaff|Health & Personal Care|greiche',
    'Hakim Optical|Health & Personal Care|hakim optical',
    'Bota Bota|Health & Personal Care|bota bota',
    'Strøm Spa|Health & Personal Care|strom spa',
    'Nautilus Plus|Health & Personal Care|nautilus plus',
    'World Gym|Health & Personal Care|world gym',
    'Anytime Fitness|Health & Personal Care|anytime fitness',
    'Orangetheory|Health & Personal Care|orangetheory',
    'Crunch Fitness|Health & Personal Care|crunch fitness',
    // --- shopping ---
    'Ogilvy|Shopping|ogilvy',
    'Holt Renfrew|Shopping|holt renfrew',
    'Sports Rousseau|Shopping|sports rousseau',
    'Latulippe|Shopping|latulippe',
    'La Cordée|Shopping|la cordee',
    'Pet Valu|Shopping|pet valu',
    'Mondou|Shopping|mondou',
    'PetSmart|Shopping|petsmart',
    'Frank & Oak|Shopping|frank & oak;frank and oak',
    'Toys R Us|Shopping|toys r us',
    'Sporting Life|Shopping|sporting life',
    // --- bills ---
    'Aviva|Bills & Utilities|aviva',
    // --- subscriptions and software ---
    'Duolingo|Subscriptions & Software|duolingo',
    'Zoom|Subscriptions & Software|zoom us;zoom video',
    'Slack|Subscriptions & Software|slack!',
    'Shopify|Subscriptions & Software|shopify',
    'Google Workspace|Subscriptions & Software|google workspace;gsuite',
    'NordVPN|Subscriptions & Software|nordvpn',
    'Proton|Subscriptions & Software|proton mail;protonmail;proton ag',
    'Cloudflare|Subscriptions & Software|cloudflare',
    'DigitalOcean|Subscriptions & Software|digitalocean',
    'Namecheap|Subscriptions & Software|namecheap',
    'Squarespace|Subscriptions & Software|squarespace',
    'HBO Max|Subscriptions & Software|hbo max;hbomax;max.com',
    // --- entertainment ---
    'La Ronde|Entertainment|six flags la ronde;la ronde',
    'Six Flags|Entertainment|six flags',
    'Cirque du Soleil|Entertainment|cirque du soleil',
    'Musée des beaux-arts|Entertainment|musee des beaux arts',
    'Pointe-à-Callière|Entertainment|pointe a calliere',
    'Biosphère|Entertainment|biosphere',
    'Espace pour la vie|Entertainment|espace pour la vie',
    'Cinéma Impérial|Entertainment|cinema imperial',
    'Club Soda|Entertainment|club soda',
    'Epic Games|Entertainment|epic games',
    'Roblox|Entertainment|roblox',
    // --- travel ---
    'Sunwing|Travel|sunwing',
    'Delta|Travel|delta air',
    'United Airlines|Travel|united airlines',
    'American Airlines|Travel|american airlines',
    'Air France|Travel|air france',
    'Lufthansa|Travel|lufthansa',
    'Turkish Airlines|Travel|turkish airlines',
    'Emirates|Travel|emirates!',
    'SÉPAQ|Travel|sepaq',
    'Parcs Canada|Travel|parks canada;parcs canada',
    'Hotels.com|Travel|hotels com',
    'Marriott|Travel|marriott',
    'Hilton|Travel|hilton',
    'Auberge|Travel|auberge!'
  ];

  // Store-type words (mostly French, since the cards are in Quebec). They set a category and keep the store's own name.
  // Words the app's older rules already know in English are left to those rules, so nothing changes for them.
  const KEYWORDS = [
    '*|Groceries|marche;epicerie;fruiterie;boucherie;poissonnerie;fromagerie;supermarche;mini marche',
    '*|Dining & Coffee|boulangerie;patisserie;brasserie;microbrasserie;casse croute;traiteur;cantine;creperie;taverne;rotisserie;chocolaterie',
    '*|Snacks|depanneur;dep!;provi soir',
    '*|Transport|stationnement;parcometre;parking',
    '*|Health & Personal Care|pharmacie;clinique;dentiste;optometr;physiotherap;chiropratic;massotherap;laboratoire;hopital;coiffure;barbier',
    '*|Bills & Utilities|assurance;loyer',
    '*|Entertainment|cinema;theatre;spectacle;musee;billetterie'
  ];

  const fold = (s) => String(s === undefined || s === null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/œ/g, 'oe');
  // n1: letters, digits and & only, one space between words. n2: the same with numbers split off the words around them,
  // so "saq23028faubourg" reads "saq 23028 faubourg".
  const norm1 = (s) => fold(s).replace(/['’]/g, '').replace(/[^a-z0-9&]+/g, ' ').trim();
  const norm2 = (s) => s.replace(/([a-z])([0-9])/g, '$1 $2').replace(/([0-9])([a-z])/g, '$1 $2');
  const esc = (p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const compile = (lines, brand) => {
    const out = [];
    lines.forEach((line) => {
      const parts = line.split('|');
      parts[2].split(';').forEach((p) => {
        const whole = p.slice(-1) === '!';
        const text = whole ? p.slice(0, -1) : p;
        out.push({ name: parts[0], cat: parts[1], brand, words: text.split(' ').length, len: text.length, re: new RegExp('(^| )' + esc(text) + (whole ? '( |$)' : '')) });
      });
    });
    // The most specific pattern first: more words, then longer ("uber eats" before "uber", "costco gas" before "costco").
    return out.sort((a, b) => b.words - a.words || b.len - a.len);
  };
  const BRAND_RULES = compile(BRANDS, true);
  const WORD_RULES = compile(KEYWORDS, false);

  // Places that follow a store name on a card statement but are not part of it.
  const PLACES = new Set(('qc que quebec ca can canada on ont ontario ab bc mb nb nl ns pe pei sk mtl montreal laval longueuil brossard gatineau ottawa toronto ' +
    'sherbrooke levis terrebonne repentigny boucherville candiac chateauguay blainville mirabel verdun lasalle outremont westmount anjou lachine pierrefonds ' +
    'kirkland dorval vaudreuil saguenay trois-rivieres troisrivieres mississauga brampton markham vaughan').split(' '));
  const SMALL = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'et', 'and', 'of', 'the', 'au', 'aux', 'sur', 'en', 'a']);

  const titleCase = (s, shout) => s.split(' ').map((w, i) => {
    if (!w) return w;
    const lw = w.toLowerCase();
    if (i > 0 && SMALL.has(lw)) return lw;
    // Short words with no vowel (STM, QC, BMR) stay in capitals when the card shouted them.
    if (shout && lw.length <= 3 && !/[aeiouyàâéèêëîïôùûü]/.test(lw)) return w.toUpperCase();
    return lw.replace(/(^|-)([a-zà-ÿ])/g, (m, p, c) => p + c.toUpperCase()).replace(/(^|\s)([a-zà-ÿ])'([a-zà-ÿ])/g, (m, p, a, b) => p + a.toUpperCase() + "'" + b.toUpperCase());
  }).join(' ');

  // The raw text with the noise taken off, in the card's own spelling.
  const tidy = (raw) => {
    let s = String(raw === undefined || raw === null ? '' : raw).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    const original = s;
    s = s.replace(/^[A-Za-z]{1,6}\s?\*\s?/, '');                       // "SQ *", "TST* ", "PP*"
    s = s.replace(/,/g, ' ').replace(/([^\d\s])(\d{4,})/g, '$1 $2').replace(/(\d{4,})([^\d\s])/g, '$1 $2');
    let tokens = s.split(' ').filter(Boolean);
    // A store number (4 or more digits) or "#123" starts the branch details: everything from there on is dropped. Shorter
    // numbers stay, because they can be part of a name ("Fruiterie 440").
    const cut = tokens.findIndex((t, i) => i > 0 && (/^#/.test(t) || /^\d{4,}$/.test(t)));
    if (cut > 0) tokens = tokens.slice(0, cut);
    tokens = tokens.filter((t) => !/^\d{4,}$/.test(t) && !/^#/.test(t));
    while (tokens.length > 1 && PLACES.has(fold(tokens[tokens.length - 1]).replace(/[^a-z-]/g, ''))) tokens.pop();
    s = tokens.join(' ').trim();
    if (!s) return original;
    const letters = s.replace(/[^A-Za-zÀ-ÿ]/g, '');
    const shout = letters.length > 0 && letters === letters.toUpperCase();
    const flat = letters.length > 0 && letters === letters.toLowerCase();
    return shout || flat ? titleCase(s, shout) : s;
  };

  const memo = new Map();
  const clean = (raw) => {
    const key = String(raw === undefined || raw === null ? '' : raw);
    if (memo.has(key)) return memo.get(key);
    let out;
    const n1 = norm1(key);
    if (!n1) out = { name: 'Unknown', category: null, how: 'none' };
    else {
      const n2 = norm2(n1);
      const hit = (rules) => rules.find((r) => r.re.test(n1) || r.re.test(n2));
      const brand = hit(BRAND_RULES);
      if (brand) out = { name: brand.name, category: brand.cat, how: 'brand' };
      else {
        const word = hit(WORD_RULES);
        out = { name: tidy(key) || key.trim(), category: word ? word.cat : null, how: word ? 'word' : 'none' };
      }
    }
    if (memo.size > 5000) memo.clear();
    memo.set(key, out);
    return out;
  };

  // The same store spelled any way gives the same key (used to remember a person's own corrections).
  const keyOf = (raw) => norm1(clean(raw).name);

  const api = { clean, keyOf, CATS, brands: BRAND_RULES.length };
  if (typeof window !== 'undefined') window.spendMerchant = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
