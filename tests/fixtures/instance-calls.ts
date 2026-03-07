import { UserService } from "./cross-file/a.js";

// Pattern 1: constructor assignment
const svc = new UserService();
export function createUser() {
  svc.create();
}

// Pattern 2: typed parameter
export function handleRequest(service: UserService) {
  service.update();
}

// Pattern 3: local class instance
class Logger {
  log(_msg: string) {}
}
const logger = new Logger();
export function doWork() {
  logger.log("hello");
}
