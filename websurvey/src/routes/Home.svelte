<script>
    import { onMount } from "svelte";
    import { navigate } from "svelte-routing";

    export let ref, typeformData;

    const { fields } = typeformData;

    const setFirstRef = (index) => {
        return fields[index].ref;
    };

    ref = setFirstRef(0);

    onMount(() => {
        navigate(`/${ref}`, { replace: true });
    });
</script>

<div class="surveyapp stack-large">loading</div>
