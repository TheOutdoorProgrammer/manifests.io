import SearchBar from "./SearchBar";
import styles from "./Layout.module.css";
import HeartTheOutdoorProgrammer from "@/components/HeartTheOutdoorProgrammer";

type Props = {
    children: React.ReactNode;
    item: string;
    version: string;
    resource?: string;
    linked?: string;
}

export default function Layout({children, item, version, resource, linked}: Props) {
    return (
        <>
            <header className={styles.header}>
                <div className={styles.wrapper}>
                    <div>
                        <h1><a href={`/${item}/${version}`}>Manifests.io</a>
                            <button onClick={() => scroll({top: document.body.scrollHeight, behavior: "smooth"})}>?
                            </button>
                        </h1>
                        <span>Easy to use kubernetes documentation</span>
                    </div>
                    <SearchBar pageItem={item} pageVersion={version} resource={resource} linked={linked}/>
                </div>
            </header>
            {children}
            <footer style={{display: 'flex', justifyContent: 'center'}}>
                <HeartTheOutdoorProgrammer/>
            </footer>
        </>
    )
}