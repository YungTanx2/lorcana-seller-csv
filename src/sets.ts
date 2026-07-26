export interface SetDef {
  id: string;       // slug
  name: string;     // display name — must match the "Set Name" column in seller dumps
  setNumber: number;
  groupId: number;  // TCGCSV group ID
}

/**
 * All Lorcana sets. `groupId` is the TCGCSV group identifier — find new IDs at:
 *   https://tcgcsv.com/tcgplayer/71/groups  (71 = Lorcana category)
 * Copied from lorcana-ev/src/sets.ts — keep in sync when new sets are added there.
 */
export const SUPPORTED_SETS: SetDef[] = [
  { id: 'the-first-chapter',     name: 'The First Chapter',     setNumber: 1,  groupId: 22937 },
  { id: 'rise-of-the-floodborn', name: 'Rise of the Floodborn', setNumber: 2,  groupId: 23303 },
  { id: 'into-the-inklands',     name: 'Into the Inklands',     setNumber: 3,  groupId: 23367 },
  { id: 'ursulas-return',        name: "Ursula's Return",        setNumber: 4,  groupId: 23474 },
  { id: 'shimmering-skies',      name: 'Shimmering Skies',      setNumber: 5,  groupId: 23536 },
  { id: 'azurite-sea',           name: 'Azurite Sea',           setNumber: 6,  groupId: 23746 },
  { id: 'archazias-island',      name: "Archazia's Island",     setNumber: 7,  groupId: 24011 },
  { id: 'reign-of-jafar',        name: 'Reign of Jafar',        setNumber: 8,  groupId: 24258 },
  { id: 'fabled',                name: 'Fabled',                setNumber: 9,  groupId: 24348 },
  { id: 'whispers-in-the-well',  name: 'Whispers in the Well',  setNumber: 10, groupId: 24414 },
  { id: 'winterspell',           name: 'Winterspell',           setNumber: 11, groupId: 24500 },
  { id: 'wilds-unknown',         name: 'Wilds Unknown',         setNumber: 12, groupId: 24617 },
  { id: 'attack-of-the-vine',    name: 'Attack of the Vine!',   setNumber: 13, groupId: 24666 },
];

export function findSetByName(setName: string): SetDef | undefined {
  return SUPPORTED_SETS.find((s) => s.name === setName);
}
