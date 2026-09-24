import { defineProviderAdapterContract } from "./provider-adapter-contract-kit";
import { createDirectoryAdapter } from "./enterprise-directory-test-kit";
defineProviderAdapterContract("ActiveDirectoryAdapter", { createAdapter: () => createDirectoryAdapter("ACTIVE_DIRECTORY").adapter,
  expectedCapabilities: ["DIRECTORY_DISCOVERY", "GROUP_DISCOVERY", "INCREMENTAL_SYNC"] });
