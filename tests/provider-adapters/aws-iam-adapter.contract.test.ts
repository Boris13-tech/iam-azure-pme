import { defineProviderAdapterContract } from "./provider-adapter-contract-kit";
import { createCloudAdapter } from "./cloud-provider-test-kit";
defineProviderAdapterContract("AwsIamAdapter", { createAdapter: () => createCloudAdapter("AWS").adapter,
  expectedCapabilities: ["DIRECTORY_DISCOVERY", "GROUP_DISCOVERY", "RESOURCE_DISCOVERY", "INCREMENTAL_SYNC"] });
