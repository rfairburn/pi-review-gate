// Keep dependency-free signer boundary cases in the normal compiled test suite.
import { join } from "node:path";
import { projectRoot } from "./helpers/release-scripts";
require(join(projectRoot(), "tests", "release-android.cases.cjs"));
