// The language guess (spec §5.1): a label over the prepared query, en or es. Dependency-free, so the local search
// adapter and the pipeline share it without importing each other.
const ES_WORDS = new Set('el la los las de del y que en un una unos unas para con por se es al lo como pero su sus mi mis esto esta este hay quiero necesito puedo hacer muy ya sin sobre entre desde'.split(' '));
const EN_WORDS = new Set('the and to of in is for with on that this it are be as at from by or an my you how what can add use need want'.split(' '));
const ES_MARKS_RE = /[áéíóúüñ¿¡]/gi;

export function guessLang(query) {
  const q = typeof query === 'string' ? query.toLowerCase() : '';
  let es = (q.match(ES_MARKS_RE) ?? []).length;
  let en = 0;
  for (const w of q.match(/\p{L}+/gu) ?? []) {
    if (ES_WORDS.has(w)) es += 1;
    if (EN_WORDS.has(w)) en += 1;
  }
  return es > en ? 'es' : 'en';
}
