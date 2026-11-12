export type FieldType = "short" | "long" | "email" | "phone" | "number" | "url" | "date" | "time" | "single" | "multi" | "dropdown" | "yesno" | "scale" | "rating" | "state" | "consent" | "statement";
export type Operator = "eq" | "neq" | "contains" | "not_contains" | "gt" | "lt" | "any_of" | "answered" | "empty";
export interface Rule { field: string; op: Operator; value?: string | string[] }
export interface Condition { mode: "all" | "any"; rules: Rule[] }
export interface FieldOption { id: string; label: string }
export interface FormField {
  id: string; type: FieldType; label: string; help?: string; required?: boolean; placeholder?: string; role?: string;
  options?: FieldOption[]; allowOther?: boolean;
  scale?: { min: number; max: number; minLabel?: string; maxLabel?: string };
  validation?: { min?: number; max?: number; minLength?: number; maxLength?: number; pattern?: string; patternMessage?: string };
  showIf?: Condition;
}
export interface FormPage { id: string; title: string; description?: string; fields: FormField[]; jumps?: Array<{ when: Condition; to: string }> }
export interface FormSchema { pages: FormPage[] }
export type AnswerValue = string | number | boolean | string[];
export type Answers = Record<string, AnswerValue | undefined>;

export const FIELD_TYPES: FieldType[];
export const CHOICE_TYPES: FieldType[];
export const OPERATORS: Operator[];
export const OTHER_PREFIX: string;
export const INDIA_STATES: string[];
export function newId(prefix?: string): string;
export function isEmpty(value: unknown): boolean;
export function displayAnswer(field: FormField, value: unknown): string;
export function conditionPasses(condition: Condition | undefined, fieldsById: Map<string, FormField>, answers: Answers): boolean;
export function allFields(schema: FormSchema): FormField[];
export function pagePath(schema: FormSchema, answers: Answers): FormPage[];
export function visibleFields(schema: FormSchema, answers: Answers, pages?: FormPage[]): FormField[];
export function validateAnswers(schema: FormSchema, answers: Answers, onlyPage?: FormPage): { ok: boolean; errors: Record<string, string>; clean: Answers };
export function normalizeSchema(input: unknown): FormSchema;
export function pipeText(template: string | undefined, schema: FormSchema, answers: Answers): string;
