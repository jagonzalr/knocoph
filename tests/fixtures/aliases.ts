import { createUser as makeUser } from "./simple.js";
export function registerUser(name: string) {
  return makeUser(name);
}
