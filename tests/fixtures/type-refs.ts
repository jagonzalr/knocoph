// Fixture for REFERENCES edge type (PR-V2-1).
// Exercises type annotations in function parameters, return types,
// interface method signatures, and type alias bodies.
import type { User } from "./simple.js";

// Cross-file type reference: greetUser -> User (parameter and return type)
export function greetUser(user: User): string {
  return `Hello ${user.name}`;
}

// Interface whose method signatures reference User — both parameter and return
export interface UserRepository {
  findById(id: string): User;
  save(user: User): void;
}

// Type alias that references User
export type UserOrNull = User | null;

// Local type used to verify same-file REFERENCES detection
export interface LocalId {
  value: string;
}

// Arrow function referencing a local type
export const makeId = (raw: string): LocalId => ({ value: raw });
