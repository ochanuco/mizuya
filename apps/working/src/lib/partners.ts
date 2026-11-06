/** パートナーの名簿。先頭は、宛先を指定しない呼び出しが使うパートナー。 */
export const PARTNER_IDS = ["yukarin", "akarin"] as const;

export type PartnerId = (typeof PARTNER_IDS)[number];
