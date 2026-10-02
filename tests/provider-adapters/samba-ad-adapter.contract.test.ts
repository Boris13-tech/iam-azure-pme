import { defineProviderAdapterContract } from "./provider-adapter-contract-kit";
import { createDirectoryAdapter } from "./enterprise-directory-test-kit";
defineProviderAdapterContract("SambaAdAdapter", { createAdapter: () => createDirectoryAdapter("SAMBA_AD").adapter,
  expectedCapabilities: ["DIRECTORY_DISCOVERY", "GROUP_DISCOVERY", "INCREMENTAL_SYNC"] });
