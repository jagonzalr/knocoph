export interface User {
  id: string;
  name: string;
}
export type UserId = string;
export enum Role {
  Admin = "admin",
  User = "user",
}
export class BaseService {
  protected log(msg: string): void {
    console.error(msg);
  }
}
export class UserService extends BaseService {
  constructor(private readonly role: Role) {
    super();
  }
  create(user: User): User {
    this.log("creating");
    return user;
  }
}
export function createUser(name: string): User {
  return { id: "1", name };
}
export const helper = (x: number) => x * 2;
