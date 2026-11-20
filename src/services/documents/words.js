const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const below100 = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? `-${ONES[n % 10]}` : ''}`);
const below1000 = (n) => (n >= 100 ? `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${below100(n % 100)}` : ''}` : below100(n));
function wholeWords(n) {
  if (n === 0) return 'zero';
  const parts = [];
  const crore = Math.floor(n / 1e7); n %= 1e7;
  const lakh = Math.floor(n / 1e5); n %= 1e5;
  const thousand = Math.floor(n / 1e3); n %= 1e3;
  if (crore) parts.push(`${wholeWords(crore)} crore`);
  if (lakh) parts.push(`${below100(lakh)} lakh`);
  if (thousand) parts.push(`${below100(thousand)} thousand`);
  if (n) parts.push(below1000(n));
  return parts.join(' ');
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** 12000 → "Twelve thousand rupees only"; 1250.5 → "One thousand two hundred fifty rupees and fifty paise only". Indian grouping (lakh, crore). */
export function amountInWords(amount) {
  const total = Math.round(Math.abs(Number(amount) || 0) * 100);
  const rupees = Math.floor(total / 100); const paise = total % 100;
  let out = `${wholeWords(rupees)} ${rupees === 1 ? 'rupee' : 'rupees'}`;
  if (paise) out += ` and ${below100(paise)} paise`;
  return `${cap(out)} only`;
}

/** Indian digit grouping with two decimals: 364000 → "3,64,000.00". */
export const inrNumber = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
