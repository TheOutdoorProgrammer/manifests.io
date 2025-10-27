import {K8sDefinitions} from "@/typings/KubernetesSpec";

import kubernetes134 from "../oaspec/kubernetes/1.34.json";
import kubernetes133 from "../oaspec/kubernetes/1.33.json";
import kubernetes132 from "../oaspec/kubernetes/1.32.json";
import kubernetes131 from "../oaspec/kubernetes/1.31.json";
import kubernetes130 from "../oaspec/kubernetes/1.30.json";
import kubernetes129 from "../oaspec/kubernetes/1.29.json";

import certmanager171 from "../oaspec/certmanager/1.7.json";
import certmanager1144 from "../oaspec/certmanager/1.14.json";

import flagger1190 from "../oaspec/flagger/1.19.0.json";

import flux201 from "../oaspec/flux/2.0.1.json";
import flux0312 from "../oaspec/flux/0.31.2.json";
import flux0273 from "../oaspec/flux/0.27.3.json";

import istio1133 from "../oaspec/istio/1.13.3.json";

import cosignpolicycontroller057 from "../oaspec/cosignpolicycontroller/0.5.7.json";

import gatewayapi100standard from "../oaspec/gatewayapi/1.0.0.json";
import gatewayapi100experimental from "../oaspec/gatewayapi/1.0.0experimental.json";
import gatewayapi110standard from "../oaspec/gatewayapi/1.1.0.json";
import gatewayapi110experimental from "../oaspec/gatewayapi/1.1.0experimental.json";
import gatewayapi111standard from "../oaspec/gatewayapi/1.1.1.json";
import gatewayapi111experimental from "../oaspec/gatewayapi/1.1.1experimental.json";
import gatewayapi120standard from "../oaspec/gatewayapi/1.2.0.json";
import gatewayapi120experimental from "../oaspec/gatewayapi/1.2.0experimental.json";

import opagatekeeper3140 from "../oaspec/opagatekeeper/3.14.0.json"

import prometheusoperator0712 from "../oaspec/prometheusoperator/0.71.2.json";

import rancher28 from "../oaspec/rancher/2.8.json";

import spaceliftoperator010 from "../oaspec/spaceliftoperator/0.1.0.json";

import spaceliftworkerpool0021 from "../oaspec/spaceliftworkerpool/0.0.21.json";

export function oaspecFetch(item: string, version: string): K8sDefinitions {
    if (item === "kubernetes") {
        switch (version) {
            case "1.34":
                return kubernetes134.definitions;
            case "1.33":
                return kubernetes133.definitions;
            case "1.32":
                return kubernetes132.definitions;
            case "1.31":
                return kubernetes131.definitions;
            case "1.30":
                return kubernetes130.definitions;
            case "1.29":
                return kubernetes129.definitions;
        }
    }

    if (item === "certmanager") {
        switch (version) {
            case "1.7":
                return certmanager171.definitions;
            case "1.14":
                return certmanager1144.definitions;
        }
    }

    if (item === "flagger") {
        if (version === "1.19.0") {
            return flagger1190.definitions;
        }
    }

    if (item === "flux") {
        switch (version) {
            case "2.0.1":
                return flux201.definitions;
            case "0.31.2":
                return flux0312.definitions;
            case "0.27.3":
                return flux0273.definitions;
        }
    }

    if (item === "istio") {
        if (version === "1.13.3") {
            return istio1133.definitions;
        }
    }

    if (item === "cosign policy-controller") {
        if (version === "0.5.7") {
            return cosignpolicycontroller057.definitions;
        }
    }

    if (item === "opa gatekeeper") {
        if (version === "3.14.0") {
            return opagatekeeper3140.definitions;
        }
    }

    if (item === "prometheus operator") {
        if (version === "0.71.2") {
            return prometheusoperator0712.definitions;
        }
    }

    if (item === "rancher") {
        if (version === "2.8") {
            return rancher28.definitions;
        }
    }

    if (item === "gateway api") {
        if (version === "1.0.0 standard") {
            return gatewayapi100standard.definitions;
        }
        if (version === "1.0.0 experimental") {
            return gatewayapi100experimental.definitions;
        }
        if (version === "1.1.0 standard") {
            return gatewayapi110standard.definitions;
        }
        if (version === "1.1.0 experimental") {
            return gatewayapi110experimental.definitions;
        }
        if (version === "1.1.1 standard") {
            return gatewayapi111standard.definitions;
        }
        if (version === "1.1.1 experimental") {
            return gatewayapi111experimental.definitions;
        }
        if (version === "1.2.0 standard") {
            return gatewayapi120standard.definitions;
        }
        if (version === "1.2.0 experimental") {
            return gatewayapi120experimental.definitions;
        }
    }

    if( item === "spacelift operator"){
        if(version === "0.1.0") {
            return spaceliftoperator010.definitions;
        }
    }

    if( item === "spacelift workerpool"){
        if(version === "0.0.21") {
            return spaceliftworkerpool0021.definitions;
        }
    }

    throw new Error("Open Api Spec Not Found");
}

export function availableItemVersions(): { [key: string]: Array<string> } {
    return {
        "certmanager": ["1.7", "1.14"],
        "cosign policy-controller": ["0.5.7"],
        "flagger": ["1.19.0"],
        "flux": ["0.27.3", "0.31.2", "2.0.1"],
        "gateway api": ["1.0.0 standard", "1.0.0 experimental", "1.1.0 standard", "1.1.0 experimental", "1.1.1 standard", "1.1.1 experimental", "1.2.0 standard", "1.2.0 experimental"],
        "istio": ["1.13.3"],
        "kubernetes": ["1.29", "1.30", "1.31", "1.32", "1.33", "1.34"],
        "opa gatekeeper": ["3.14.0"],
        "prometheus operator": ["0.71.2"],
        "rancher": ["2.8"],
        "spacelift operator": ["0.1.0"],
        "spacelift workerpool": ["0.0.21"]
    }
}

export function defaultItemVersion(): { item: string, version: string } {
    return {
        item: "kubernetes",
        version: "1.34"
    }
}
