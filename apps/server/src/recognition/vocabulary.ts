/** Labels the tagger looks for. Search also accepts the plurals in `TAG_ALIASES`. */
export const SCENE_TAGS = [
  { slug: 'birthday', name: 'Birthday', label: 'birthday' },
  { slug: 'party', name: 'Party', label: 'party' },
  { slug: 'cake', name: 'Cake', label: 'cake' },
  { slug: 'cat', name: 'Cat', label: 'cat' },
  { slug: 'dog', name: 'Dog', label: 'dog' },
] as const;

/** Words that should find the same tag. "cats" finds photos tagged cat. */
export const TAG_ALIASES: Record<string, string> = {
  birthdays: 'birthday',
  parties: 'party',
  cakes: 'cake',
  cats: 'cat',
  kittens: 'cat',
  kitten: 'cat',
  dogs: 'dog',
  doggy: 'dog',
  puppy: 'dog',
  puppies: 'dog',
};
