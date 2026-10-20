// Stop words of the local suggestion search: English and Spanish function words plus the filler of chat prompts
// ("can you make sure…", "dale, armá…"). FTS5 has no stop-word list, so without this every prompt matched almost every
// skill through words like "the", "de" or "con", and a skill written in Spanish ranked first for any Spanish prompt.
// Words are compared lowercase and accent-free. Dependency-free.

const fold = (t) => t.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

const ENGLISH = `a about above after again against all am an and any are as at be because been before being below between
both but by can could did do does doing done down during each few for from further had has have having he her here hers
him his how i if in into is it its itself just me more most my no nor not now of off on once only or other our out over
own same she should so some such than that the their them then there these they this those through to too under until up
very was we were what when where which while who whom why will with would you your yours yourself ok okay yes yeah please
pls let lets make sure need want get got go going thing things stuff something also really actually maybe right still`;

const SPANISH = `a al algo algun alguna algunas alguno algunos ante antes asi aca ahi aqui ahora bien bueno che como con contra cual
cuando dale de del desde donde durante e el ella ellas ellos en entre era es esa esas ese eso esos esta estaba estan estas
este esto estos favor fue fueron ha hace hacelo haceme hacer hay la las le les listo lo los mas me mi mis mucho muy nada
necesito ni no nos o os otra otro para pero poco podes podrias por porfa porque puedo que quien quiero se sea ser si sin
sobre su sus tambien te tenemos tengo tiene tienen ti toda todas todo todos tu tus un una uno unos unas vamos vos y ya yo
ayudame cosa cosas seguimos sigue`;

export const STOP_WORDS = new Set(`${ENGLISH} ${SPANISH}`.split(/\s+/).filter(Boolean).map(fold));

// The terms that carry meaning, in their original order and spelling.
export function contentTerms(terms) {
  return terms.filter((t) => !STOP_WORDS.has(fold(t)));
}
