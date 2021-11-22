<script>
    import { navigate } from "svelte-routing";
    import { createEventDispatcher } from "svelte";

    export let fields;

    export let ref;

    let dispatch = createEventDispatcher();

    let index = fields.findIndex((field) => field.ref === ref);

    let field = fields[index];

    const handleSubmit = () => {
        index += 1;
        field = fields[index];
        ref = field.ref;
        navigate(`/${ref}`, { replace: true });
        dispatch("updateRef", ref);
    };
</script>

<div class="surveyapp stack-large">
    <form on:submit|preventDefault={handleSubmit}>
        <div class="stack-small">
            <h1 class="h1">Hey! Welcome to our fun survey</h1>
            <button type="submit" class="btn">Let's go</button>
        </div>
    </form>
</div>
