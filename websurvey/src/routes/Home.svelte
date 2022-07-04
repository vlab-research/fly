<script>
    import { onMount } from "svelte";
    import { navigate } from "svelte-routing";
    export let form;

    import { setFirstRef } from "../../lib/typewheels/form.js";

    let ref;

    ref = setFirstRef(form, 0);

    onMount(() => {
        navigate(`/${ref}`, { replace: true });
    });
</script>

<div class="surveyapp stack-large">loading</div>
