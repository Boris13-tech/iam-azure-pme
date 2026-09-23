import { defineProviderAdapterContract } from "./provider-adapter-contract-kit";
import { createCloudAdapter } from "./cloud-provider-test-kit";
defineProviderAdapterContract("GoogleWorkspaceAdapter", { createAdapter: () => createCloudAdapter("GOOGLE_WORKSPACE").adapter,
  expectedCapabilities: ["DIRECTORY_DISCOVERY", "GROUP_DISCOVERY", "RESOURCE_DISCOVERY", "INCREMENTAL_SYNC"] });
