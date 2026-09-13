import { INVOCATIONS, PACKAGE_NAME } from "./descriptors.ts";
export { PACKAGE_NAME };

export const TYPERT = {
  package: PACKAGE_NAME,
  face: "host" as const,
  schemas: [],
  model: {
    services: [],
    events: [],
    objects: [],
  },
  invocations: INVOCATIONS,
};
