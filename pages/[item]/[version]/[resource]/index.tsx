import styles from '@/styles/Home.module.css'
import {GetServerSideProps} from "next";
import {oaspecFetch} from "@/lib/oaspec";
import Layout from '@/components/Layout';
import ResourceTable from "@/components/ResourceTable";
import ReportIssue from "@/components/ReportIssue";
import ManifestsHeading from "@/components/ManifestsHeading";
import {NextParsedUrlQuery} from "next/dist/server/request-meta";
import {K8sDefinitions, K8sProperty, K8sPropertyArray} from "@/typings/KubernetesSpec";
import {Resource} from "@/typings/Resource";
import { trace, SpanStatusCode } from '@opentelemetry/api';

type OtherVersions = {
    keys: Array<string>;
    gvk: {
        [key: string]: {
            group: string;
            kind: string;
            version: string;
        };
    }
}

type OtherPropertyVersions = {
    [key: string]: {
        [key: string]: K8sProperty
    }
}

type Props = {
    resources: Array<Resource>;
    item: string;
    version: string;
    linkedResource: string;
    description: string;
    resource: string;
    otherVersions: OtherVersions;
    otherPropertyVersions?: OtherPropertyVersions;
    required?: Array<string>;
    oneOf?: Array<Resource>;
};

function Gvk({otherVersions, resource}: { otherVersions: OtherVersions, resource: string }) {
    return (<div>
        {otherVersions.keys.map((gvk) => {
            const thisGVK = otherVersions.gvk[gvk];
            if (gvk == resource) {
                return (<p key={gvk}><a href={gvk}><b><span
                    className="link">{thisGVK.group}/{thisGVK.version}/{thisGVK.kind}</span></b></a></p>)
            }
            return (<p key={gvk}><a href={gvk}><span
                className="link">{thisGVK.group}/{thisGVK.version}/{thisGVK.kind}</span></a></p>)
        })}
    </div>)
}

export default function Home({
                                 resources,
                                 item,
                                 version,
                                 linkedResource,
                                 description,
                                 resource,
                                 otherVersions,
                                 required,
                                 otherPropertyVersions,
                                 oneOf,
                             }: Props) {
    function replaceWithWbr(str: string) {
        const splitStr = str.split(".");
        return splitStr.map((str, i) => {
            if (i === splitStr.length - 1) {
                return <span key={str}>{str}</span>
            }
            return <span key={str}>{str}
                <wbr/>.</span>
        });
    }

    return (
        <Layout item={item} version={version} resource={resource} linked={linkedResource}>
            <ManifestsHeading
                item={item}
                version={version}
                description={description}
                resource={resource}
            />
            <main className={styles.main}>
                <h1 style={{
                    marginTop: "20px",
                    marginBottom: "50px",
                    overflowWrap: "break-word"
                }}>{replaceWithWbr(linkedResource)}</h1>
                {otherVersions.keys.length > 0 && (
                    <div style={{marginTop: "-30px", marginBottom: "30px", textAlign: "center"}}>
                        <h2>Group/Version/Kind</h2>
                        <Gvk otherVersions={otherVersions} resource={resource}/>
                    </div>
                )}
                <p style={{whiteSpace: "pre-wrap"}}>{description}</p>
                <ResourceTable leftHeading="Key"
                               required={required}
                               resources={oneOf ? oneOf : resources}
                               item={item}
                               version={version}
                               linkedResource={linkedResource}
                               otherPropertyVersions={otherPropertyVersions}
                               resourceTitle={resource}/>
                <ReportIssue resource={resource} item={item}/>
            </main>
        </Layout>
    )
}

const tracer = trace.getTracer('manifestsio-pages');

export const getServerSideProps: GetServerSideProps = async ({query}) => {
    return tracer.startActiveSpan('getServerSideProps.resourceDetail', async (span) => {
        try {
    function parseQuery(query: NextParsedUrlQuery) {
        let {item, version, resource, linked, oneOf, key} = query;
        if (Array.isArray(item) || !item) {
            throw new Error("Item is not a string");
        }
        if (Array.isArray(version) || !version) {
            throw new Error("Version is not a string");
        }
        if (Array.isArray(resource) || !resource) {
            throw new Error("Resource is not a string");
        }
        if (Array.isArray(linked)) {
            throw new Error("Linked is not a string");
        }
        if (Array.isArray(oneOf)) {
            throw new Error("oneOf is not a string");
        }
        if (Array.isArray(key)) {
            throw new Error("key is not a string");
        }
        return {item, version, resource, linked, oneOf, key};
    }

    function defaultString(value: string | undefined, defaultValue?: string): string {
        if (value === undefined) {
            return defaultValue ? defaultValue : "";
        }
        return value;
    }

    function popString(value: string): string {
        let returnValue = value.split(".").pop()?.split("/").pop();
        if (returnValue === undefined) {
            return value;
        }
        return returnValue;
    }

    function removeOASpecLinkText(value: string): string {
        return value.replace("#/definitions/", "").replace("#/components/schemas/", "");
    }

    function buildResource(resource: string, key: string, value: any): Resource {
        let resourceObj: Resource = {resource, description: defaultString(value.description), key, type: "Unknown"};
        if (value.$ref) {
            resourceObj.links = true;
            resourceObj.key = removeOASpecLinkText(value.$ref);
            resourceObj.type = value.type ? value.type : popString(value.$ref);
        } else {
            if (value.items && value.items.$ref) {
                resourceObj.links = true;
                resourceObj.key = removeOASpecLinkText(value.items.$ref);
                resourceObj.type = `${popString(value.items.$ref)}[]`;
            } else {
                resourceObj.type = value.type ? value.type : resource;
            }
        }
        return resourceObj;
    }

    function getResourceArrayFromSpec(spec: K8sDefinitions, linked?: string): Array<Resource> {

        function isValidResource(resource: string | undefined, resourceNames: string[]): boolean {
            return (resource && !resource.endsWith("List") && !(resourceNames.includes(resource))) as boolean;
        }

        let resources: Array<Resource> = [];
        let resourceNames: Array<string> = [];
        const resourceSpec = spec[resource];
        if (resourceSpec.properties) {
            for (const [key, value] of Object.entries(resourceSpec.properties)) {
                const resource = popString(key);
                if (isValidResource(resource, resourceNames)) {
                    resources.push(buildResource(resource, key, value));
                    resourceNames.push(resource);
                }
            }
        } else if (resourceSpec.items && resourceSpec.items.properties) {
            for (const [key, value] of Object.entries(resourceSpec.items.properties)) {
                const resource = popString(key);
                if (isValidResource(resource, resourceNames)) {
                    resources.push(buildResource(resource, key, value));
                    resourceNames.push(resource);
                }
            }
        } else if (resourceSpec.items) {
            for (const [key, value] of Object.entries(resourceSpec.items)) {
                const resource = linked ? popString(linked) : popString(key);
                if (isValidResource(resource, resourceNames)) {
                    resources.push({
                        resource: "",
                        description: defaultString(resourceSpec.description),
                        type: `${value}[]`,
                        key: resource
                    });
                    resourceNames.push(resource);
                }
            }
        } else {
            resources.push({
                resource: popString(resource),
                description: defaultString(resourceSpec.description),
                type: "Unknown",
                key: resource
            });
        }
        resources.sort((a, b) => (a.resource > b.resource) ? 1 : -1);
        return resources
    }

    function findOtherPropertyVersions(resourceSearch: string, spec: K8sDefinitions): OtherPropertyVersions {
        const otherPropertyVersions: OtherPropertyVersions = {};
        const thisResource = spec[resourceSearch];
        if (thisResource?.properties) {
            for (const [key, value] of Object.entries(thisResource.properties)) {
                if ((value as K8sPropertyArray).oneOf) {
                    for (const property of (value as K8sPropertyArray).oneOf) {
                        const title = defaultString(property.title);
                        if (!(key in otherPropertyVersions)) {
                            otherPropertyVersions[key] = {};
                        }
                        otherPropertyVersions[key][title] = property;
                    }
                }
            }
        }
        return otherPropertyVersions;
    }

    function findOtherResourceVersions(resourceSearch: string, spec: K8sDefinitions): OtherVersions {
        const searchableResource = popString(resourceSearch);
        let keys: Array<string> = [];
        let gvk: { [key: string]: { group: string; kind: string; version: string; }; } = {};
        for (const [key, value] of Object.entries(spec)) {
            if ("x-kubernetes-group-version-kind" in value && value["x-kubernetes-group-version-kind"] !== undefined
            ) {
                const resource = popString(key);
                if (resource && searchableResource == resource && !resource.endsWith("List") && !(keys.includes(resource))) {
                    keys.push(key);
                    gvk[key] = value["x-kubernetes-group-version-kind"][0];
                }
            }
        }
        return {keys, gvk};
    }

    const {item, version, resource, linked, oneOf, key} = parseQuery(query);

    span.setAttribute('manifestsio.item', item);
    span.setAttribute('manifestsio.version', version);
    span.setAttribute('manifestsio.resource', resource);

    let spec = oaspecFetch(item, version);

    let linkedResource = defaultString(linked, popString(resource));
    const resources = getResourceArrayFromSpec(spec, linked);
    const otherVersions = findOtherResourceVersions(resource, spec);
    let otherPropertyVersions: OtherPropertyVersions = findOtherPropertyVersions(resource, spec);

    let oneOfClicked: Array<Resource> | null = null;
    if (oneOf && key) {
        spec = {};
        spec[resource] = otherPropertyVersions[key][oneOf];
        linkedResource = `${linkedResource}.${key}`
        oneOfClicked = getResourceArrayFromSpec(spec, undefined)
        otherPropertyVersions = {};
    }

    const resourceSpec = spec[resource];

    let props: Props = {
        resources,
        item,
        version,
        linkedResource,
        description: defaultString(resourceSpec.description),
        resource,
        otherVersions
    };

    if (resourceSpec.required) {
        props["required"] = resourceSpec.required;
    }

    if (Object.keys(otherPropertyVersions).length > 0) {
        props["otherPropertyVersions"] = otherPropertyVersions;
    }

    if (oneOfClicked) {
        props["oneOf"] = oneOfClicked;
    }

    span.setStatus({ code: SpanStatusCode.OK });
    return {
        props
    }
        } catch (error) {
            span.setStatus({
                code: SpanStatusCode.ERROR,
                message: error instanceof Error ? error.message : 'Unknown error'
            });
            span.recordException(error as Error);
            throw error;
        } finally {
            span.end();
        }
    });
}