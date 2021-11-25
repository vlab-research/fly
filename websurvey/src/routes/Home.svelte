<script>
    import { navigate } from "svelte-routing";
    export let ref, fields;

    const setFirstRef = (index) => {
        return fields[index].ref;
    };
    ref = setFirstRef(0);
    setTimeout(() => {
        navigate(`/${ref}`, { replace: true });
    }, 0);
</script>

<div class="surveyapp stack-large">loading</div>
