import { defineProviderAdapterContract } from "./provider-adapter-contract-kit";
import { createDirectoryAdapter } from "./enterprise-directory-test-kit";
defineProviderAdapterContract("LdapAdapter", { createAdapter: () => createDirectoryAdapter("LDAP").adapter,
  expectedCapabilities: ["DIRECTORY_DISCOVERY", "GROUP_DISCOVERY", "INCREMENTAL_SYNC"] });
